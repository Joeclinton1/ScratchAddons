class Profiler {
  constructor(config) {
    this.currentBlock = null;
    this.totalRTC = 0;
    this.thread = null;
    this.originalStepThread;
    this.config = config;
    this.rtcCache = new Map();
    this.rtcTable = {};
    this.profilerActive = false;
    this.tm = null;
  }

  patchThreadBlockGlowInFrame(thread, profiler) {
    if (!thread) return;

    const desc = Object.getOwnPropertyDescriptor(thread, "blockGlowInFrame");

    // already patched?
    if (desc && typeof desc.set === "function" && desc.set.__profilerPatched) return;

    Object.defineProperty(thread, "blockGlowInFrame", {
      get() {
        return this._blockGlowInFrame;
      },
      set(v) {
        profiler.profilerActive = true;
        this._blockGlowInFrame = v;
      },
      configurable: true,
    });
    Object.getOwnPropertyDescriptor(thread, "blockGlowInFrame").set.__profilerPatched = true;
  }

  polluteStepThread(vm) {
    this.config.isStepThreadPolluted = true;
    this.vm = vm;
    this.originalStepThread = vm.runtime.sequencer.stepThread;
    const profiler = this;

    /*
    Execute() is called once per line of scratch code to evaluate recursively every block in that line.
    We aim to start our timer just before execute is called, and then stop it the next time execute is called.
    Ideally we'd just wrap execute() with a function that calls profile(),
    however without access to execute() we can't just wrap it, so we need to be creative in how we hook our code in.

    The key idea is that there are two properties that are got/set just before and after execute() that we can use.
    - runtime.profiler is got once before execute() so we start the profiler here. We then set profiling to inactive to prevent triggering during execute
      https://github.com/scratchfoundation/scratch-vm/blob/b3266a0cfe5122f20b72ccd738a3dd4dff4fc5a5/src/engine/sequencer.js#L201
    - mainthread.blockGlowInFrame is set once after execute() so we use this to set profiler back to active priming for next loop
      https://github.com/scratchfoundation/scratch-vm/blob/b3266a0cfe5122f20b72ccd738a3dd4dff4fc5a5/src/engine/sequencer.js#L214

    Since there are many points in runtime and execute where runtime.profiler is got, we must make sure to have profiler start inactive and only become active inside stepThread.
    StepThread will run a while loop of block execution and the key is to have the profiler active just before execute, inactive during and reactivate after.

    we only start timers in profile() and we don't end them in blockGlowInFrame because we want to measure the full time from one block to the other.
    After profile starts the new timer it will end the previous one.
    */

    this.originalProfilerDescriptor = Object.getOwnPropertyDescriptor(vm.runtime, "profiler");
    Object.defineProperty(vm.runtime, "profiler", {
      get() {
        if (profiler.profilerActive) profiler.profile();
        return null;
      },
    });

    vm.runtime.sequencer.stepThread = function (...args) {
      profiler.thread = this.activeThread;
      profiler.patchThreadBlockGlowInFrame(profiler.thread, profiler);

      profiler.profilerActive = true; // set to active here before the stepThread so that our first profile() will get called just before execute
      const result = profiler.originalStepThread.apply(this, args);
      profiler.profilerActive = false;

      if (profiler.currentBlock !== null) profiler.tm.stopTimer(profiler.currentBlock); // stop timer at end of thread to end any timers that are still open.
      profiler.currentBlock = null;

      return result;
    };

    vm.runtime.on("PROJECT_CHANGED", () => profiler.clearRtcCache());
  }

  /*
  Cleanup to prevent VM crashes when single-step debugger also hooks blockGlowInFrame.
  Store original state, make properties configurable, restore on cleanup.
  */
  unpolluteStepThread() {
    if (!this.config.isStepThreadPolluted) return;

    this.profilerActive = false;
    this.vm.runtime.sequencer.stepThread = this.originalStepThread;

    if (this.originalProfilerDescriptor) {
      Object.defineProperty(this.vm.runtime, "profiler", this.originalProfilerDescriptor);
    } else {
      delete this.vm.runtime.profiler;
    }

    // technically we should be unpolluting every thread that we polluted whilst running the debugger to remove the block blockGlowInFrame property definition change,
    // but this doesn't cause a conflict with the stepThreading, and the next time you click green flag you'll get all new threads,
    // so we're going to be lazy and not unpollute the instance

    this.config.isStepThreadPolluted = false;
  }

  profile() {
    this.profilerActive = false; // set to false so that it won't be triggered during execute (which contains a profile get)

    const blockId = this.thread.peekStack();
    if (blockId === null || this.thread.blockContainer._blocks[blockId]?.isMonitored === true) return;

    if (this.config.showLineByLine) this.tm.startTimer(blockId, this.thread.target.id, blockId);

    if (this.config.showLineByLine && this.currentBlock !== null) this.tm.stopTimer(this.currentBlock);

    if (this.config.showRTC)
      this.totalRTC += this.getRTCofBlockLine(blockId, this.thread.blockContainer._blocks, this.thread.target);

    this.currentBlock = blockId;
  }

  getN(block, target) {
    const listField = block.fields?.LIST;
    if (listField) {
      // lookupVariableById also finds global lists owned by the stage.
      const variable =
        (listField.id && target.lookupVariableById?.(listField.id)) ??
        (listField.id && target.variables?.[listField.id]) ??
        target.lookupVariableByNameAndType?.(listField.value, "list");
      return Array.isArray(variable?.value) ? variable.value.length : 0;
    } else if (Object.keys(block.inputs ?? {}).length) {
      // this block is almost certainly string contains but unfortunately there's no way to get the reported value of just the elements inside this string
      // instead we'll just pretend the reported string was length 10
      return 10;
    }
    // something has gone wrong as all O(n) blocks have either a LIST field or an input field.
    // If 0 is returned, the RTC table is likely formatted wrong, and needs fixing.
    return 0;
  }

  getRTCofBlockLine(rootBlockId, blocks, target) {
    if (this.rtcCache.has(rootBlockId)) {
      return this.rtcCache.get(rootBlockId);
    }
    const block = blocks[rootBlockId];
    if (block === undefined) return 0;
    const inputs = Object.values(block.inputs);
    const fields = Object.values(block.fields);
    const fieldKeys = Object.keys(block.fields);
    let field =
      fields.length && ["EFFECT", "OPERATOR"].includes(fieldKeys[0]) ? ":" + fields[0].value.toLowerCase() : "";

    if (block.opcode === "pen_stamp") {
      // if the block is stamp then RTC depends on whether we are stamping bitmap or vector
      field = target.sprite?.costumes?.[target.currentCostume]?.dataFormat === "svg" ? ":vector" : ":bitmap";
    }
    let rtc = this.rtcTable[block.opcode + field];

    // If RTC is given by two values in the table then the operation has O(n) time complexity and depends on the string/list length
    const inputDependent = Array.isArray(rtc);
    rtc = inputDependent ? rtc[1] + rtc[0] * this.getN(block, target) : rtc;
    const ownRTC = block.opcode && rtc && rtc !== "N/A" ? rtc : 0;
    const childrenRTC =
      inputs.length !== 0
        ? inputs
            .filter((input) => input?.block && !input.name?.includes("SUBSTACK"))
            .map((input) => this.getRTCofBlockLine(input.block, blocks, target))
            .reduce((acc, curr) => acc + curr, 0)
        : 0;
    const totalRTC = ownRTC + childrenRTC;

    // If the RTC is independent of the input then it never changes and we can cache it
    if (!inputDependent && block.opcode !== "pen_stamp") this.rtcCache.set(rootBlockId, totalRTC);

    return totalRTC;
  }

  clearRtcCache() {
    this.rtcCache.clear();
  }
}

export default Profiler;
