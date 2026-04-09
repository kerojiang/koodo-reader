import React from "react";
import ReactDOM from "react-dom";
import "./assets/styles/reset.css";
import "./assets/styles/global.css";
import "./assets/styles/style.css";
import { Provider } from "react-redux";
import "./i18n";
import store from "./store";
import Router from "./router/index";
import StyleUtil from "./utils/reader/styleUtil";
import { initSystemFont, initTheme } from "./utils/reader/launchUtil";
import { migrateThemeConfig } from "./utils/reader/themeUtil";
import edgeTTSService from "./utils/common/edgeTTSService";
import { isElectron } from "react-device-detect";

initTheme();
initSystemFont();
migrateThemeConfig();

// 应用启动时立即在后台初始化 Edge TTS 服务
if (isElectron) {
  console.log('[App] 开始初始化 Edge TTS 服务...');
  edgeTTSService.init().then(() => {
    console.log('[App] Edge TTS 服务初始化完成, 可用:', edgeTTSService.isAvailable());
  }).catch(err => {
    console.error('[App] Edge TTS 服务初始化失败:', err);
  });
}

ReactDOM.render(
  <Provider store={store}>
    <Router />
  </Provider>,
  document.getElementById("root")
);
StyleUtil.applyTheme();
