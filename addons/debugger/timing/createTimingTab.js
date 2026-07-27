import TimingManager from "./TimingManager.js";
import HeatmapManager from "./HeatmapManager.js";
import Profiler from "./Profiler.js";
import { createTableHeader } from "./ui-components/tableHeader.js";
import TableRows from "./ui-components/TableRows.js"; // Importing the extended LogView class
import RTCTableComponent from "./ui-components/RTCTable.js";
import { updateAllBlocksEvents } from "../../../libraries/common/cs/update-all-blocks.js";
import downloadBlob from "../../../libraries/common/cs/download-blob.js";
import { isPaused, onPauseChanged, getRunningThread } from "../module.js";

export default async function createTimingTab({ debug, addon, console, msg }) {
  function openRTCTablePopup() {
    const popupWindow = window.open(
      "",
      "_blank",
      "toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes,width=800,height=600"
    );
    if (!popupWindow) return;

    popupWindow.document.title = msg("timing-rtc");
    Object.assign(popupWindow.document.body.style, {
      margin: "0",
      height: "100vh",
      backgroundColor: "#f0f0f0",
    });

    const rtcTableContainer = Object.assign(popupWindow.document.createElement("div"), {
      id: "rtcTableContainer",
    });
    Object.assign(rtcTableContainer.style, {
      width: "100%",
      height: "100%",
      overflow: "auto",
    });
    popupWindow.document.body.appendChild(rtcTableContainer);

    const style = popupWindow.document.createElement("style");
    style.textContent = `
      .sa-rtc-table {
        border-collapse: collapse;
        width: 100%;
        margin: 0;
        color: black;
        font-family: sans-serif;
        font-size: 12px;
      }
      .sa-rtc-table th, .sa-rtc-table td {
        border: 1px solid #ccc;
        text-align: center;
        padding: 3px;
        word-wrap: break-word;
        white-space: normal;
      }
      .sa-rtc-table th {
        background-color: #f2f2f2;
        font-weight: bold;
      }
    `;
    popupWindow.document.head.appendChild(style);

    new RTCTableComponent(addon.self.dir + "/timing/RTC.json").renderInto(rtcTableContainer);
  }

  function createContent() {
    const content = Object.assign(document.createElement("div"), {
      className: "sa-timing-content",
    });
    content.appendChild(tableHeader);
    content.appendChild(tableRows.outerElement);

    return content;
  }

  function createLineByLineButton() {
    const lineByLineButton = debug.createIconButton({
      text: msg("timing-profiling"),
    });

    // Add checkbox to the left side of the button
    const checkbox = Object.assign(document.createElement("input"), {
      type: "checkbox",
      className: "sa-timing-checkbox",
    });

    // Add specific class
    lineByLineButton.element.classList.add("sa-timing-profiling-toggle");

    // Prepend checkbox to button (left side)
    lineByLineButton.element.insertBefore(checkbox, lineByLineButton.element.firstChild);

    // Make entire button clickable to toggle checkbox
    lineByLineButton.element.addEventListener("click", (e) => {
      // Don't double-toggle if clicking directly on checkbox
      if (e.target !== checkbox) {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change"));
      }
    });

    // Handle checkbox change
    checkbox.addEventListener("change", () => {
      config.showLineByLine = checkbox.checked;
      if (config.showLineByLine && !config.isStepThreadPolluted) {
        polluteStepThread();
      } else if (!config.showLineByLine && !config.showRTC && config.isStepThreadPolluted) {
        unpolluteStepThread();
      }
    });

    lineByLineButton.checkbox = checkbox;
    return lineByLineButton;
  }

  function attachOperationCostInfo(rtcHeader) {
    rtcHeader.classList.add("sa-timing-tooltip-container");
    const tooltip = document.createElement("div");
    tooltip.className = "sa-timing-tooltip-outer";
    tooltip.innerHTML = `
      <div class="sa-timing-tooltip-content">
        <p>${msg("timing-rtc-info", {
          table: `<a href="#" class="sa-timing-rtc-table-link">${msg("timing-rtc-info-table")}</a>`,
        })}</p>
      </div>
    `;
    tooltip.addEventListener("click", (event) => event.stopPropagation());
    tooltip.querySelector(".sa-timing-rtc-table-link").addEventListener("click", (event) => {
      event.preventDefault();
      openRTCTablePopup();
    });
    rtcHeader.appendChild(tooltip);
  }

  function createHeatmapButton() {
    const heatmapButton = debug.createIconButton({
      text: msg("timing-heatmap"),
    });

    // Add checkbox to the left side of the button
    const checkbox = Object.assign(document.createElement("input"), {
      type: "checkbox",
      className: "sa-timing-checkbox",
    });

    // Create slider container (initially hidden)
    const sliderContainer = Object.assign(document.createElement("div"), {
      className: "sa-timing-heatmap-slider-container",
    });

    // Create slider track
    const sliderTrack = Object.assign(document.createElement("div"), {
      className: "sa-timing-heatmap-slider-track",
    });

    // Create slider thumb
    const sliderThumb = Object.assign(document.createElement("div"), {
      className: "sa-timing-heatmap-slider-thumb",
    });

    sliderTrack.appendChild(sliderThumb);
    sliderContainer.appendChild(sliderTrack);

    // Create a wrapper for the original button content (checkbox + icon + text)
    const buttonContentWrapper = Object.assign(document.createElement("div"), {
      className: "sa-timing-heatmap-content-wrapper",
    });

    // Move existing content into the wrapper
    const existingContent = Array.from(heatmapButton.element.children);
    existingContent.forEach((child) => buttonContentWrapper.appendChild(child));

    // Add specific class to disable hover effect
    heatmapButton.element.classList.add("sa-timing-heatmap-toggle");

    // Prepend checkbox to wrapper (left side)
    buttonContentWrapper.insertBefore(checkbox, buttonContentWrapper.firstChild);
    heatmapButton.element.appendChild(buttonContentWrapper);
    heatmapButton.element.appendChild(sliderContainer);

    // Slider state
    let isDragging = false;
    let hasInteractedWithSlider = false;

    // Update slider position based on value
    const updateSliderPosition = (value) => {
      const percentage = value * 100;
      sliderThumb.style.left = `${percentage}%`;
    };

    // Initialize slider position
    updateSliderPosition(config.currentHeatmapMax);

    // Slider interaction handlers
    const handleSliderInteraction = (e) => {
      e.stopPropagation(); // Prevent checkbox toggle
      const rect = sliderTrack.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      config.currentHeatmapMax = x / rect.width;
      updateSliderPosition(config.currentHeatmapMax);

      if (config.showHeatmap) {
        heatmapManager.showHeatmapFn(config.currentHeatmapMax);
      }
    };

    const handleMouseMove = (e) => {
      if (isDragging) {
        handleSliderInteraction(e);
      }
    };

    const handleMouseUp = () => {
      isDragging = false;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);

      // Set a flag to prevent button toggle for a short time after dragging
      hasInteractedWithSlider = true;
      setTimeout(() => {
        hasInteractedWithSlider = false;
      }, 50); // 50ms delay to prevent accidental toggles
    };

    sliderTrack.addEventListener("mousedown", (e) => {
      isDragging = true;
      handleSliderInteraction(e);
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    });

    // Make entire button clickable to toggle checkbox (except slider area)
    heatmapButton.element.addEventListener("click", (e) => {
      // Don't toggle if clicking on checkbox, slider, or recently interacted with slider
      if (e.target !== checkbox && !sliderContainer.contains(e.target) && !hasInteractedWithSlider) {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change"));
      }
    });

    // Handle checkbox change
    checkbox.addEventListener("change", () => {
      config.showHeatmap = checkbox.checked;
      sliderContainer.style.display = checkbox.checked ? "block" : "none";

      if (config.showHeatmap) {
        heatmapManager.showHeatmapFn(config.currentHeatmapMax);
      } else {
        heatmapManager.hideHeatmapFn();
      }
    });

    // Initially hide slider
    sliderContainer.style.display = "none";

    return heatmapButton;
  }

  function createExportButton() {
    const exportButton = debug.createIconButton({
      text: msg("export"),
      icon: addon.self.dir + "/icons/download-white.svg",
    });

    exportButton.element.addEventListener("click", () => {
      if (tableRows.rows.length === 0) return;

      // Create CSV headers
      const headers = [
        "Label",
        "Total Time (ms)",
        "Avg Time (ms)",
        config.showRatioTime ? "Ratio Time" : "Percent Time",
        "Call Count",
        ...(config.showRTC ? ["Operation Cost"] : []),
      ];

      // Create CSV rows
      const rows = tableRows.rows.map((row) => {
        const values = Object.values(tableRows.getRowValues(row));
        // Convert non-breaking space back to empty string for CSV export
        if (values[0] === "\u00A0") {
          values[0] = "";
        }
        // Escape any commas in the label by wrapping in quotes
        values[0] = values[0].includes(",") ? `"${values[0]}"` : values[0];
        return values.join(",");
      });

      const csvContent = [headers.join(","), ...rows].join("\n");
      const filename = `timing_${tableRows.rows[0].label}.csv`;
      downloadBlob(filename, new Blob([csvContent], { type: "text/plain" }));
    });

    return exportButton;
  }

  function createClearButton() {
    const clearButton = debug.createIconButton({
      text: msg("clear"),
      icon: addon.self.dir + "/icons/delete.svg",
    });

    clearButton.element.addEventListener("click", () => {
      timingManager.clearTimers();
      tableRows.updateLogRows(timingManager.getTimers(), config.showLineByLine);
      heatmapManager.modifiedTimers.clear();

      if (config.showHeatmap) {
        heatmapManager.hideHeatmapFn();
        setTimeout(() => config.showHeatmap && heatmapManager.startRealtimeUpdates(config.currentHeatmapMax), 10);
      }
    });

    return clearButton;
  }

  function updatePercentageHeader() {
    const value = addon.settings.get("show_ratio_time");
    config.showRatioTime = value;
    percentHeader.textContent = value ? msg("timing-ratio-time") : msg("timing-percent-time");
  }

  function getOperationCostSetting() {
    try {
      return addon.settings.get("show_operation_cost");
    } catch {
      // The background page can briefly retain the old manifest during extension development.
      return false;
    }
  }

  function updateOperationCostSetting() {
    config.showRTC = getOperationCostSetting();
    rtcHeader.style.display = config.showRTC ? "" : "none";

    const isSingleStepping = isPaused() && getRunningThread();
    if (config.showRTC && !isSingleStepping && !config.isStepThreadPolluted) {
      polluteStepThread();
    } else if (!config.showRTC && !config.showLineByLine && config.isStepThreadPolluted) {
      unpolluteStepThread();
    }

    tableRows.updateLogRows(timingManager.getTimers(), config.showLineByLine);
  }

  // Config shared by timing controls and addon settings.
  const config = {
    showRTC: getOperationCostSetting(),
    showLineByLine: false,
    showHeatmap: false,
    showRatioTime: false,
    sortHeader: null,
    sortDirection: "descending",
    isStepThreadPolluted: false,
    currentHeatmapMax: 1.0, // Store heatmap max value for reapply operations
  };
  const { tableHeader, rtcHeader, percentHeader } = createTableHeader(config, msg);
  attachOperationCostInfo(rtcHeader);
  const tableRows = new TableRows(config, debug, msg, tableHeader);

  const profiler = new Profiler(config);
  try {
    const response = await fetch(addon.self.dir + "/timing/RTC.json");
    profiler.rtcTable = await response.json();
    profiler.clearRtcCache();
  } catch (error) {
    console.error("Error loading JSON:", error);
  }

  // function to pollute stepThread with our new Profiler to handle line by line profiling
  const polluteStepThread = () => profiler.polluteStepThread(addon.tab.traps.vm, timingManager);
  const unpolluteStepThread = () => profiler.unpolluteStepThread();

  const timingManager = new TimingManager(addon.settings, config, profiler);
  const heatmapManager = new HeatmapManager(
    () => addon.tab.traps.getWorkspace(),
    tableRows,
    config,
    addon.tab.traps.vm
  );
  profiler.tm = timingManager;
  timingManager.heatmapManager = heatmapManager; // Connect them for real-time updates

  const content = createContent();
  const exportButton = createExportButton();
  const clearButton = createClearButton();
  const lineByLineButton = createLineByLineButton();
  const heatmapButton = createHeatmapButton();

  // setup events
  debug.addAfterStepCallback(() => {
    tableRows.updateLogRows(timingManager.getTimers(), config.showLineByLine);
  });

  // Handle single-step state changes
  const handleSingleStepChange = (paused) => {
    const isSingleStepping = paused && getRunningThread();
    if (isSingleStepping && config.showLineByLine) {
      config.showLineByLine = false;
      lineByLineButton.checkbox.checked = false;
    }
    if (isSingleStepping && config.isStepThreadPolluted) {
      profiler.unpolluteStepThread();
    } else if (!isSingleStepping && (config.showLineByLine || config.showRTC) && !config.isStepThreadPolluted) {
      polluteStepThread();
    }
    // Update button disabled states
    lineByLineButton.element.disabled = isSingleStepping;
    if (isSingleStepping) {
      lineByLineButton.element.classList.add("sa-timing-disabled");
    } else {
      lineByLineButton.element.classList.remove("sa-timing-disabled");
    }
  };

  handleSingleStepChange(isPaused());
  onPauseChanged(handleSingleStepChange);

  // Listen for blocks being updated/recreated and reapply heatmap if needed
  updateAllBlocksEvents.addEventListener("blocksUpdated", () => {
    if (config.showHeatmap) {
      setTimeout(() => {
        heatmapManager.showHeatmapFn(config.currentHeatmapMax);
      }, 10);
    }
  });

  // Handle sprite switching to reapply heatmap
  addon.tab.redux.addEventListener("statechanged", ({ detail }) => {
    if (detail.action.type === "scratch-gui/targets/UPDATE_TARGET_LIST") {
      if (config.showHeatmap) {
        setTimeout(() => {
          heatmapManager.showHeatmapFn(config.currentHeatmapMax);
        }, 10);
      }
    }
  });

  addon.settings.addEventListener("change", function () {
    updatePercentageHeader();
    updateOperationCostSetting();
  });
  updatePercentageHeader();
  updateOperationCostSetting();

  // create the tab
  const tab = debug.createHeaderTab({
    text: msg("tab-timing"),
    icon: addon.self.dir + "/icons/timing.svg",
  });

  return {
    tab,
    content,
    buttons: [exportButton, clearButton, lineByLineButton, heatmapButton],
    show: () => {
      tableRows.show();
      // Restart real-time heatmap updates when tab is shown
      if (config.showHeatmap) {
        heatmapManager.startRealtimeUpdates(config.currentHeatmapMax);
      }
    },
    hide: () => {
      tableRows.hide();
      // Stop real-time heatmap updates when tab is hidden
      if (config.showHeatmap) {
        heatmapManager.stopRealtimeUpdates();
      }
    },
    startTimer: timingManager.startTimer.bind(timingManager),
    stopTimer: timingManager.stopTimer.bind(timingManager),
    clearTimers: timingManager.clearTimers.bind(timingManager),
  };
}
