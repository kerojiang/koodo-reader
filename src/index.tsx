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
import {
  initSystemFont,
  initTheme,
  applyCustomSystemCSS,
  applyAppBackgroundImage,
} from "./utils/reader/launchUtil";
import { migrateConfig } from "./utils/common";
import kerojiangTTSService from "./utils/common/kerojiangTTSService";
import { isElectron } from "react-device-detect";
initTheme();
initSystemFont();
migrateConfig();
applyCustomSystemCSS();
applyAppBackgroundImage();
const container = document.getElementById("root")!;

// 应用启动时立即在后台初始化 Kerojiang TTS 服务
if (isElectron) {
  console.log('[App] 开始初始化 Kerojiang TTS 服务...');
  kerojiangTTSService.init().then(() => {
    console.log('[App] Kerojiang TTS 服务初始化完成, 可用:', kerojiangTTSService.isAvailable());
  }).catch(err => {
    console.error('[App] Kerojiang TTS 服务初始化失败:', err);
  });
}

ReactDOM.render(
  <Provider store={store}>
    <Router />
  </Provider>,
  container
);
StyleUtil.applyTheme();
