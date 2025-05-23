const prefix = window.location.pathname.substr(
  0,
  window.location.pathname.toLowerCase().lastIndexOf("/extensions") + 1
);
const config = {
  host: window.location.hostname,
  prefix: prefix,
  port: window.location.port,
  isSecure: window.location.protocol === "https:",
};

require.config({
  baseUrl:
    (config.isSecure ? "https://" : "http://") +
    config.host +
    (config.port ? ":" + config.port : "") +
    config.prefix +
    "resources",
  paths: {
    jquery: "/resources/assets/external/jquery/jquery.min",
    jszip: "/extensions/app-to-json-v2/js/jszip.min",
  },
});

require(["js/qlik", "jquery", "jszip"], function (qlik, $, JSZip) {
  "use strict";

  const state = {
    selectedApps: new Set(),
    isExporting: false,
    global: null,
  };

  const elements = {
    exportBtn: document.getElementById("exportBtn"),
    selectAll: document.getElementById("selectAll"),
    appList: document.getElementById("appList"),
    appTable: document.getElementById("appTable"),
    tableLoading: document.getElementById("tableLoading"),
    loader: document.getElementById("loader"),
    progressContainer: document.getElementById("progressContainer"),
    progressBar: document.getElementById("progressBar"),
    progressText: document.querySelector(".progress-text"),
    progressStatus: document.getElementById("progressStatus"),
  };

  const init = async () => {
    try {
      showTableLoading(true);
      await setupQlikConnection();
      await loadApps();
      setupEventListeners();
    } catch (error) {
      console.error("Initialization error:", error);
      showError("Failed to initialize the application. Please refresh the page.");
    } finally {
      showTableLoading(false);
    }
  };

  const setupQlikConnection = async () => {
    try {
      state.global = qlik.getGlobal(config);
      if (!state.global) {
        throw new Error("Failed to establish Qlik connection");
      }
    } catch (error) {
      console.error("Connection error:", error);
      throw error;
    }
  };

  const loadApps = async () => {
    try {
      const apps = await new Promise((resolve, reject) => {
        state.global.getAppList((apps) => {
          resolve(
            apps.map((app) => ({
              qDocId: app.qDocId,
              qDocName: app.qDocName,
              qMeta: {
                published: app.qMeta ? app.qMeta.published : true,
                modifiedDate: app.qMeta ? app.qMeta.modifiedDate : new Date().toISOString(),
                stream: app.qMeta && app.qMeta.stream ? app.qMeta.stream.name : "My Work",
              },
            }))
          );
        });
      });

      // console.log("Apps loaded:", apps);

      renderAppList(apps);
    } catch (error) {
      console.error("Error loading apps:", error);
      showError("Failed to load apps. Please try again.");
    }
  };

  const renderAppList = (apps) => {
    const streamGroups = apps
      .filter((app) => app.qMeta.published)
      .reduce((groups, app) => {
        const streamName = app.qMeta.stream || "My Work";
        if (!groups[streamName]) {
          groups[streamName] = [];
        }
        groups[streamName].push(app);
        return groups;
      }, {});

    const sortedStreams = Object.keys(streamGroups).sort((a, b) => {
      if (a === "My Work") return -1;
      if (b === "My Work") return 1;
      return a.localeCompare(b);
    });

    elements.appList.innerHTML = sortedStreams
      .map(
        (streamName) => `
          <tr class="stream-header">
            <td colspan="4">
              <div class="stream-name">
                <input type="checkbox" 
                       class="stream-checkbox" 
                       data-stream="${streamName}">
                <strong>${streamName}</strong>
                <span class="app-count">(${streamGroups[streamName].length} apps)</span>
              </div>
            </td>
          </tr>
          ${streamGroups[streamName]
            .map(
              (app) => `
                <tr class="stream-${streamName.replace(/\s+/g, "-")}">
                    <td>
                        <input type="checkbox" 
                               class="app-checkbox" 
                               data-id="${app.qDocId}"
                               data-name="${app.qDocName}"
                               data-stream="${streamName}">
                    </td>
                    <td>${app.qDocName}</td>
                    <td>${new Date(app.qMeta.modifiedDate).toLocaleDateString()}</td>
                    <!-- <td>${app.qMeta.published ? "Yes" : "No"}</td> -->
                </tr>
              `
            )
            .join("")}
        `
      )
      .join("");

    document.querySelectorAll(".stream-checkbox").forEach((streamCheckbox) => {
      streamCheckbox.addEventListener("change", (event) => {
        const streamName = event.target.dataset.stream;
        const streamApps = document.querySelectorAll(`.stream-${streamName.replace(/\s+/g, "-")} .app-checkbox`);
        streamApps.forEach((appCheckbox) => {
          appCheckbox.checked = event.target.checked;
          updateSelectedApps(appCheckbox);
        });
        updateExportButton();
      });
    });
  };

  const setupEventListeners = () => {
    elements.selectAll.addEventListener("change", handleSelectAll);
    elements.appList.addEventListener("change", handleAppSelection);
    elements.exportBtn.addEventListener("click", handleExport);
  };

  const handleSelectAll = (event) => {
    document.querySelectorAll(".stream-checkbox").forEach((streamCheckbox) => {
      streamCheckbox.checked = event.target.checked;
    });

    const checkboxes = document.querySelectorAll(".app-checkbox");
    checkboxes.forEach((checkbox) => {
      checkbox.checked = event.target.checked;
      updateSelectedApps(checkbox);
    });
    updateExportButton();
  };

  const handleAppSelection = (event) => {
    if (event.target.classList.contains("app-checkbox")) {
      updateSelectedApps(event.target);
      updateExportButton();
    }
  };

  const updateSelectedApps = (checkbox) => {
    const appData = {
      id: checkbox.dataset.id,
      name: checkbox.dataset.name,
    };

    if (checkbox.checked) {
      state.selectedApps.add(JSON.stringify(appData));
    } else {
      state.selectedApps.delete(JSON.stringify(appData));
    }
  };

  const updateExportButton = () => {
    elements.exportBtn.disabled = state.selectedApps.size === 0;
  };

  const handleExport = async () => {
    if (state.isExporting) return;

    state.isExporting = true;
    elements.exportBtn.disabled = true;
    elements.loader.style.display = "block";
    elements.progressContainer.style.display = "block";

    try {
      const selectedApps = Array.from(state.selectedApps).map((app) => JSON.parse(app));
      const zip = new JSZip();

      for (let i = 0; i < selectedApps.length; i++) {
        const app = selectedApps[i];
        updateProgress(i, selectedApps.length);

        try {
          const appData = await exportApp(app.id);
          zip.file(`${app.name}.json`, JSON.stringify(appData, null, 2));
        } catch (error) {
          console.error(`Failed to export ${app.name}:`, error);
          showError(`Failed to export ${app.name}`);
        }
      }

      updateProgress(selectedApps.length, selectedApps.length);
      await downloadZip(zip);
    } catch (error) {
      console.error("Export error:", error);
      showError("Export failed. Please try again.");
    } finally {
      resetExportState();
    }
  };

  const exportApp = async (appId) => {
    try {
      const app = qlik.openApp(appId);
      if (!app) {
        throw new Error("Failed to open app");
      }

      const appData = {
        properties: {},
        fields: [],
        measures: [],
        dimensions: [],
        bookmarks: [],
        selectionObjects: [],
        snapshots: [],
        medias: [],
        sheets: [],
        masterObjects: [],
        variables: [],
        stories: [],
        scripts: "",

        // dataconnections: [],
      };

      const appLayout = await app.getAppLayout();
      if (appLayout && appLayout.layout) {
        appData.properties = appLayout.layout;
      }

      const fieldList = await app.getList("FieldList");
      if (fieldList && fieldList.layout && fieldList.layout.qFieldList) {
        appData.fields = fieldList.layout.qFieldList.qItems || [];
      }

      const measureList = await app.getList("MeasureList");
      if (measureList && measureList.layout && measureList.layout.qMeasureList) {
        appData.measures = measureList.layout.qMeasureList.qItems || [];
      }

      const dimensionList = await app.getList("DimensionList");
      if (dimensionList && dimensionList.layout && dimensionList.layout.qDimensionList) {
        appData.dimensions = dimensionList.layout.qDimensionList.qItems || [];
      }

      const bookmarkList = await app.getList("BookmarkList");
      if (bookmarkList && bookmarkList.layout && bookmarkList.layout.qBookmarkList) {
        appData.bookmarks = bookmarkList.layout.qBookmarkList.qItems || [];
      }

      const selectionObjectList = await app.getList("SelectionObject");
      if (selectionObjectList && selectionObjectList.layout && selectionObjectList.layout.qSelectionObject) {
        appData.selectionObjects = selectionObjectList.layout.qSelectionObject || [];
      }

      const snapshotList = await app.getList("SnapshotList");
      if (snapshotList && snapshotList.layout && snapshotList.layout.qBookmarkList) {
        appData.snapshots = snapshotList.layout.qBookmarkList.qItems || [];
      }

      const mediaList = await app.getList("MediaList");
      if (mediaList && mediaList.layout && mediaList.layout.qMediaList) {
        appData.embeddedmedia = mediaList.layout.qMediaList.qItems || [];
      }

      const sheetList = await app.getList("sheet");
      if (sheetList && sheetList.layout && sheetList.layout.qAppObjectList) {
        const sheets = sheetList.layout.qAppObjectList.qItems || [];
        
        appData.sheets = await Promise.all(sheets.map(async (sheet) => {
          try {
            const sheetObject = await app.getObject(sheet.qInfo.qId);
            if (!sheetObject) return sheet;

            const sheetProperties = await sheetObject.getProperties();
            if (!sheetProperties) return sheet;

            const enhancedSheet = {
              ...sheet,
              qProperty: sheetProperties
            };

            if (sheet.qData && sheet.qData.cells) {
              const cellObjects = await Promise.all(sheet.qData.cells.map(async (cell) => {
                try {
                  if (!cell.name) return cell;
                  
                  const cellObject = await app.getObject(cell.name);
                  if (!cellObject) return cell;

                  const cellProperties = await cellObject.getProperties();
                  if (!cellProperties) return cell;

                  return {
                    ...cell,
                    qProperty: cellProperties
                  };
                } catch (error) {
                  console.warn(`Failed to get properties for cell ${cell.name}:`, error);
                  return cell;
                }
              }));

              enhancedSheet.qData.cells = cellObjects;
              if (!enhancedSheet.qChildren) {
                enhancedSheet.qChildren = cellObjects.map(cell => ({
                  qProperty: cell.qProperty
                }));
              }
            }

            return enhancedSheet;
          } catch (error) {
            console.warn(`Failed to get properties for sheet ${sheet.qInfo.qId}:`, error);
            return sheet;
          }
        }));
      }

      const masterList = await app.getList("MasterObject");
      if (masterList && masterList.layout && masterList.layout.qAppObjectList) {
        appData.masterObjects = masterList.layout.qAppObjectList.qItems || [];
      }

      const variableList = await app.getList("VariableList");
      if (variableList && variableList.layout && variableList.layout.qVariableList) {
        appData.variables = variableList.layout.qVariableList.qItems || [];
      }

      const storyList = await app.getList("story");
      if (storyList && storyList.layout && storyList.layout.qAppObjectList) {
        appData.stories = storyList.layout.qAppObjectList.qItems || [];
      }

      const script = await app.getScript();
      if (script && script.qScript) {
        appData.scripts = script.qScript;
      }

      // let dataConnectionList;

      return appData;
    } catch (error) {
      console.error("Error exporting app:", error);
      throw error;
    }
  };

  const updateProgress = (current, total) => {
    const percentage = Math.round((current / total) * 100);
    elements.progressBar.style.width = `${percentage}%`;
    elements.progressText.textContent = `${percentage}%`;
    elements.progressStatus.textContent = `Processing ${current}/${total} apps`;
  };

  const downloadZip = async (zip) => {
    const content = await zip.generateAsync({ type: "blob" });
    const url = window.URL.createObjectURL(content);
    const link = document.createElement("a");
    link.href = url;
    link.download = "qlik-apps-export.zip";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  const resetExportState = () => {
    state.isExporting = false;
    elements.exportBtn.disabled = false;
    elements.loader.style.display = "none";
    elements.progressContainer.style.display = "none";
    elements.progressBar.style.width = "0%";
    elements.progressText.textContent = "0%";
    elements.progressStatus.textContent = "Processing 0/0 apps";
  };

  const showError = (message) => {
    console.error(message);
    alert(message);
  };

  const showTableLoading = (show) => {
    elements.tableLoading.style.display = show ? "flex" : "none";
    elements.appTable.style.display = show ? "none" : "table";
    elements.appTable.classList.toggle("loaded", !show);
  };

  init();
});
