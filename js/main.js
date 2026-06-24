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

  let activeOpenReject = null;

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

      if (typeof qlik.setOnError === "function") {
        qlik.setOnError((error) => {
          console.error("Qlik engine error:", error);
          if (activeOpenReject) {
            const reject = activeOpenReject;
            activeOpenReject = null;
            reject(new Error((error && error.message) || "Qlik engine error (access denied?)"));
          }
        });
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

  const EXPORT_TIMEOUT_MS = 60000;

  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms)
      ),
    ]);

  const uniqueFileName = (usedNames, name) => {
    let candidate = name;
    let counter = 2;
    while (usedNames.has(candidate)) {
      candidate = `${name} (${counter++})`;
    }
    usedNames.add(candidate);
    return candidate;
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
      const usedNames = new Set();
      const failed = [];

      for (let i = 0; i < selectedApps.length; i++) {
        const app = selectedApps[i];
        updateProgress(i, selectedApps.length);

        try {
          const appData = await withTimeout(exportApp(app.id), EXPORT_TIMEOUT_MS, app.name);
          zip.file(`${uniqueFileName(usedNames, app.name)}.json`, JSON.stringify(appData, null, 2));
        } catch (error) {
          console.error(`Failed to export ${app.name}:`, error);
          failed.push(app.name);
        }
      }

      updateProgress(selectedApps.length, selectedApps.length);

      if (Object.keys(zip.files).length > 0) {
        await downloadZip(zip);
      }

      if (failed.length > 0) {
        showError(`Could not export ${failed.length} app(s):\n${failed.join("\n")}`);
      }
    } catch (error) {
      console.error("Export error:", error);
      showError("Export failed. Please try again.");
    } finally {
      resetExportState();
    }
  };

  const getEngineDoc = async (app) => {
    for (let i = 0; i < 40 && !app.model.enigmaModel; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return app.model.enigmaModel || null;
  };

  const exportApp = async (appId) => {
    let app;
    try {
      app = qlik.openApp(appId);
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
      };

      const appLayout = await new Promise((resolve, reject) => {
        activeOpenReject = reject;
        app.getAppLayout().then(resolve, reject);
      }).finally(() => {
        activeOpenReject = null;
      });
      if (appLayout && appLayout.layout) {
        appData.properties = appLayout.layout;
      }

      const doc = await getEngineDoc(app);
      if (!doc) {
        console.warn("Engine doc unavailable; exporting list metadata only (no deep definitions).");
      }

      const enrich = (items, fetchDefinition) =>
        Promise.all(
          items.map(async (item) => {
            const id = item.qInfo && item.qInfo.qId;
            try {
              return { ...item, ...(await fetchDefinition(id)) };
            } catch (error) {
              console.warn(`Failed to fetch definition for ${id}:`, error);
              return item;
            }
          })
        );

      const fetchObjectTree = async (id) => {
        const handle = await doc.getObject(id);
        const tree = await handle.getFullPropertyTree();
        return { qProperty: tree.qProperty, qChildren: tree.qChildren };
      };

      const fieldList = await app.getList("FieldList");
      if (fieldList && fieldList.layout && fieldList.layout.qFieldList) {
        appData.fields = fieldList.layout.qFieldList.qItems || [];
      }

      const measureList = await app.getList("MeasureList");
      if (measureList && measureList.layout && measureList.layout.qMeasureList) {
        const items = measureList.layout.qMeasureList.qItems || [];
        appData.measures = await enrich(items, async (id) => {
          const handle = await doc.getMeasure(id);
          return { qProperty: await handle.getProperties() };
        });
      }

      const dimensionList = await app.getList("DimensionList");
      if (dimensionList && dimensionList.layout && dimensionList.layout.qDimensionList) {
        const items = dimensionList.layout.qDimensionList.qItems || [];
        appData.dimensions = await enrich(items, async (id) => {
          const handle = await doc.getDimension(id);
          return { qProperty: await handle.getProperties() };
        });
      }

      const bookmarkList = await app.getList("BookmarkList");
      if (bookmarkList && bookmarkList.layout && bookmarkList.layout.qBookmarkList) {
        const items = bookmarkList.layout.qBookmarkList.qItems || [];
        appData.bookmarks = await enrich(items, async (id) => {
          const handle = await doc.getBookmark(id);
          return { qProperty: await handle.getProperties() };
        });
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
        appData.medias = mediaList.layout.qMediaList.qItems || [];
      }

      const sheetList = await app.getList("sheet");
      if (sheetList && sheetList.layout && sheetList.layout.qAppObjectList) {
        const items = sheetList.layout.qAppObjectList.qItems || [];
        appData.sheets = await enrich(items, fetchObjectTree);
      }

      const masterList = await app.getList("MasterObject");
      if (masterList && masterList.layout && masterList.layout.qAppObjectList) {
        const items = masterList.layout.qAppObjectList.qItems || [];
        appData.masterObjects = await enrich(items, fetchObjectTree);
      }

      const variableList = await app.getList("VariableList");
      if (variableList && variableList.layout && variableList.layout.qVariableList) {
        appData.variables = variableList.layout.qVariableList.qItems || [];
      }

      const storyList = await app.getList("story");
      if (storyList && storyList.layout && storyList.layout.qAppObjectList) {
        const items = storyList.layout.qAppObjectList.qItems || [];
        appData.stories = await enrich(items, fetchObjectTree);
      }

      const script = await app.getScript();
      if (script && script.qScript) {
        appData.scripts = script.qScript;
      }

      return appData;
    } catch (error) {
      console.error("Error exporting app:", error);
      throw error;
    } finally {
      if (app && typeof app.close === "function") {
        Promise.resolve(app.close()).catch((e) => console.warn("Failed to close app session:", e));
      }
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
