const {
  app,
  BrowserWindow,
  WebContentsView,
  Menu,
  Tray,
  nativeImage,
  ipcMain,
  dialog,
  powerSaveBlocker,
  nativeTheme: electronNativeTheme,
  protocol,
  screen,
  systemPreferences,
} = require("electron");
const WebSocket = require('ws');
const crypto = require('crypto');
const path = require("path");
const isDev = require("electron-is-dev");
const Store = require("electron-store");
const log = require("electron-log/main");
const os = require("os");
const { execFile } = require("child_process");
const store = new Store();
const fs = require("fs");
const configDir = app.getPath("userData");
const dirPath = path.join(configDir, "uploads");
const packageJson = require("./package.json");
let mainWin;
let tray = null;
let isQuitting = false;
let readerWindow;
let readerWindowList = [];
let dictWindow;
let transWindow;
let linkWindow;
let mainView;
//multi tab
// let mainViewList = []
let readerWindowReadyToClose = false;
let chatWindow;
let dbConnection = {};
let syncUtilCache = {};
let pickerUtilCache = {};
let downloadRequest = null;

const RESIZE_THROTTLE_MS = 300;

const throttle = (func, wait = RESIZE_THROTTLE_MS) => {
  let lastCall = 0;
  let timeoutId = null;
  return function (...args) {
    const now = Date.now();
    const invoke = () => {
      lastCall = Date.now();
      func.apply(this, args);
    };
    if (now - lastCall >= wait) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      invoke();
    } else if (!timeoutId) {
      timeoutId = setTimeout(
        () => {
          timeoutId = null;
          invoke();
        },
        wait - (now - lastCall)
      );
    }
  };
};

const extractClixmlErrors = (text) => {
  if (!text) return "";
  const matches = text.match(
    /<S S="Error">([^<]*(?:<[^/][^>]*>[^<]*<\/[^>]*>)*[^<]*)<\/S>/g
  );
  if (!matches) return text;
  return matches
    .map((m) =>
      m
        .replace(/<\/?S[^>]*>/g, "")
        .replace(/<[^>]+>/g, "")
        .replace(/_x000D__x000A_/g, "\n")
        .trim()
    )
    .filter(Boolean)
    .join("\n");
};

const runPowerShellScript = (script, timeout = 30000) => {
  return new Promise((resolve, reject) => {
    const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Sta",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedCommand,
      ],
      {
        windowsHide: true,
        timeout,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const rawMessage = (stderr || stdout || error.message || "").trim();
          const cleanMessage = extractClixmlErrors(rawMessage) || rawMessage;
          reject(new Error(cleanMessage));
          return;
        }
        resolve((stdout || "").trim());
      }
    );
  });
};

const OCR_TEMP_DIR = path.join(configDir, "ocr-tmp");

// macOS OCR 二进制支持的语言（VNRecognizeTextRequest recognitionLanguages）
const MACOS_OCR_LANGS = new Set([
  "zh-Hans",
  "zh-Hant",
  "en-US",
  "ja-JP",
  "ko-KR",
  "fr-FR",
]);

// 把渲染进程传入的语言代码映射为各平台可识别的标签
// key: 应用内统一代码；value: { macos, win }
const OCR_LANG_MAP = {
  "zh-CN": { macos: "zh-Hans", win: "zh-Hans-CN" },
  "zh-SG": { macos: "zh-Hans", win: "zh-Hans-CN" },
  "zh-TW": { macos: "zh-Hant", win: "zh-Hant-TW" },
  "zh-HK": { macos: "zh-Hant", win: "zh-Hant-HK" },
  "zh-Hans": { macos: "zh-Hans", win: "zh-Hans-CN" },
  "zh-Hant": { macos: "zh-Hant", win: "zh-Hant-TW" },
  en: { macos: "en-US", win: "en-US" },
  "en-US": { macos: "en-US", win: "en-US" },
  "en-GB": { macos: "en-US", win: "en-GB" },
  ja: { macos: "ja-JP", win: "ja" },
  "ja-JP": { macos: "ja-JP", win: "ja" },
  ko: { macos: "ko-KR", win: "ko" },
  "ko-KR": { macos: "ko-KR", win: "ko" },
  fr: { macos: "fr-FR", win: "fr" },
  "fr-FR": { macos: "fr-FR", win: "fr" },
};

const resolveOcrLang = (lang) => {
  if (!lang || lang === "auto") return { macos: "auto", win: "auto" };
  return OCR_LANG_MAP[lang] || { macos: lang, win: lang };
};

// 从 base64 或 dataURL 中解析出 { buffer, ext }
const parseOcrImageInput = (input) => {
  if (typeof input !== "string" || !input) {
    throw new Error("Invalid image data");
  }
  // dataURL: data:image/png;base64,xxxx
  const dataUrlMatch = input.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
  if (dataUrlMatch) {
    const ext =
      dataUrlMatch[1].toLowerCase() === "jpeg"
        ? "jpg"
        : dataUrlMatch[1].toLowerCase();
    return { buffer: Buffer.from(dataUrlMatch[2], "base64"), ext };
  }
  // 纯 base64，按 PNG 处理
  return { buffer: Buffer.from(input, "base64"), ext: "png" };
};

const writeOcrTempImage = (buffer, ext) => {
  if (!fs.existsSync(OCR_TEMP_DIR)) {
    fs.mkdirSync(OCR_TEMP_DIR, { recursive: true });
  }
  const fileName = `ocr-${process.pid}-${Date.now()}.${ext}`;
  const filePath = path.join(OCR_TEMP_DIR, fileName);
  fs.writeFileSync(filePath, buffer);
  return filePath;
};

const cleanWindowsOcrText = (text) => {
  if (!text) return text;
  // Windows.Media.Ocr 对中日韩等无词边界的语言按"字"分词，Text 用空格连接，
  // 导致中文每字之间出现空格。循环去除 CJK 文字/全角标点之间的空格，
  // 保留英文与数字之间的空格。单次 replace 无法合并连续序列（如"符 号 学"），
  // 需循环直到无变化。
  //
  // CJK 范围用 Unicode 码点表示：
  //   一-龿   CJK 统一汉字（基本区）
  //   㐀-䶿   CJK 扩展 A 区
  //   ぀-ヿ   日文平假名 / 片假名
  //   가-힯   韩文谚文音节
  //   　-〿   CJK 符号与标点（全角空格、· 、。 等）
  //   ＀-￯   全角符号（全角字母数字、（） 等）
  const cjk =
    "\\u4e00-\\u9fbf\\u3400-\\u4dbf\\u3040-\\u30ff\\uac00-\\ud7af\\u3000-\\u303f\\uff00-\\uffef";
  const pattern = new RegExp("([" + cjk + "])\\s+([" + cjk + "])", "gu");
  let prev;
  let cur = text;
  do {
    prev = cur;
    cur = cur.replace(pattern, "$1$2");
  } while (cur !== prev);
  return cur;
};

// Windows: 通过 PowerShell 调用 Windows.Media.Ocr (WinRT)
const runWindowsOcr = (imagePath, winLang) => {
  // PowerShell 脚本里用单引号包裹路径，需转义内部单引号
  const escapePsSingle = (s) => s.replace(/'/g, "''");
  const escapedPath = escapePsSingle(imagePath);
  const langClause =
    winLang === "auto"
      ? "[Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]::TryCreateFromUserProfileLanguages()"
      : "$( $__lang = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]::new('" +
        escapePsSingle(winLang) +
        "'); [Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]::TryCreateFromLanguage($__lang) )";
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
function EncodeOut($prefix, $text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  Write-Output -NoEnumerate ($prefix + [Convert]::ToBase64String($bytes))
}
try {
  $path = '${escapedPath}'
  $file = Await ([Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = ${langClause}
  if ($null -eq $engine) { Write-Output 'LANGERR'; exit 0 }
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  EncodeOut 'OK' $result.Text
} catch {
  EncodeOut 'ERR' $_.Exception.Message
  exit 0
}
`;
  return runPowerShellScript(script, 60000).then((text) => {
    const trimmed = (text || "").trim();
    if (!trimmed) {
      throw new Error("Windows OCR returned empty result");
    }
    if (trimmed === "LANGERR") {
      const err = new Error(
        "Language package not installed! See: https://support.microsoft.com/help/17213"
      );
      err.code = "LANG_NOT_INSTALLED";
      throw err;
    }
    if (trimmed.startsWith("ERR")) {
      const msg = Buffer.from(trimmed.slice(3), "base64")
        .toString("utf8")
        .trim();
      throw new Error(msg || "Windows OCR failed");
    }
    if (trimmed.startsWith("OK")) {
      const b64 = trimmed.slice(2);
      const raw = b64 ? Buffer.from(b64, "base64").toString("utf8") : "";
      return cleanWindowsOcrText(raw);
    }
    throw new Error("Windows OCR returned unexpected output");
  });
};

// macOS: 调用打包的 Vision framework 二进制
const runMacosOcr = (imagePath, macosLang) => {
  const arch = process.arch; // arm64 / x64
  const archName =
    arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  const binPath = isDev
    ? path.join(__dirname, "assets/macos/ocr-" + archName + "-apple-darwin")
    : path.join(
        process.resourcesPath,
        "assets/macos/ocr-" + archName + "-apple-darwin"
      );
  if (!fs.existsSync(binPath)) {
    const err = new Error("macOS OCR binary not found: " + binPath);
    err.code = "BIN_NOT_FOUND";
    throw err;
  }
  return new Promise((resolve, reject) => {
    execFile(
      binPath,
      [imagePath, macosLang],
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const msg = (stderr || error.message || "").trim();
          const err = new Error(msg || "macOS OCR failed");
          err.code = "BIN_FAILED";
          reject(err);
          return;
        }
        resolve((stdout || "").trim());
      }
    );
  });
};

const getWindowHandleValue = (win) => {
  if (!win || typeof win.getNativeWindowHandle !== "function") {
    return "";
  }

  try {
    const handle = win.getNativeWindowHandle();
    if (!Buffer.isBuffer(handle) || handle.length === 0) {
      return "";
    }

    if (handle.length >= 8 && typeof handle.readBigUInt64LE === "function") {
      return handle.readBigUInt64LE(0).toString();
    }

    return handle.readUInt32LE(0).toString();
  } catch (error) {
    console.warn("Failed to resolve native window handle:", error);
    return "";
  }
};

const loadUrlInAuxWindow = async (win, url) => {
  const wc = win.webContents;
  let currentUrl = "";
  try {
    currentUrl = wc.getURL();
  } catch (_) {
    currentUrl = "";
  }
  if (currentUrl === url) {
    wc.reload();
    return;
  }
  let needBlankIntermediate = false;
  try {
    const current = new URL(currentUrl);
    const next = new URL(url);
    // When only the hash differs, Chromium treats it as a same-page hashchange
    // and won't reload the page. Navigating through about:blank forces a full reload.
    needBlankIntermediate =
      current.origin === next.origin &&
      current.pathname === next.pathname &&
      current.search === next.search;
  } catch (_) {
    // ignore invalid URLs (e.g. empty string, about:blank)
  }
  if (needBlankIntermediate) {
    await wc.loadURL("about:blank");
  }
  await wc.loadURL(url);
};

const getWindowsHelloScript = (mode, message = "", hwnd = "") => {
  const escapedMessage = message.replace(/'/g, "''");
  const escapedHwnd = String(hwnd || "").replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

function Invoke-WinRtAsync {
  param(
    [Parameter(Mandatory = $true)] $Operation,
    [Parameter(Mandatory = $true)] [Type[]] $ResultTypes
  )

  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.IsGenericMethodDefinition -and
      $_.GetGenericArguments().Count -eq $ResultTypes.Count -and
      $_.GetParameters().Count -eq 1
    } |
    Select-Object -First 1

  if (-not $method) {
    throw 'Unable to bridge Windows Runtime async operation.'
  }

  $genericMethod = $method.MakeGenericMethod($ResultTypes)
  $task = $genericMethod.Invoke($null, @($Operation))
  return $task.GetAwaiter().GetResult()
}

function Request-WindowsHelloVerification {
  param(
    [Parameter(Mandatory = $true)] [string] $Message,
    [string] $Hwnd
  )

  $isWindowInteropSupported = [Environment]::OSVersion.Version.Build -ge 22000 -and -not [string]::IsNullOrWhiteSpace($Hwnd)

  if (-not $isWindowInteropSupported) {
    return Invoke-WinRtAsync -Operation ($verifier::RequestVerificationAsync($Message)) -ResultTypes @([Windows.Security.Credentials.UI.UserConsentVerificationResult])
  }

  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace KoodoReaderInterop
{
    [ComImport]
    [Guid("39E050C3-4E74-441A-8DC0-B81104DF949C")]
    [InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
    public interface IUserConsentVerifierInterop
    {
        [return: MarshalAs(UnmanagedType.IInspectable)]
        object RequestVerificationForWindowAsync(
            IntPtr appWindow,
            [MarshalAs(UnmanagedType.HString)] string message,
            [In] ref Guid riid);
    }

    public static class UserConsentVerifierInteropHelper
    {
        public static object RequestVerificationForWindow(object activationFactory, long hwnd, string message, Guid riid)
        {
            IntPtr ptr = IntPtr.Zero;

            try
            {
                ptr = Marshal.GetIUnknownForObject(activationFactory);
                var interop = (IUserConsentVerifierInterop)Marshal.GetTypedObjectForIUnknown(ptr, typeof(IUserConsentVerifierInterop));
                return interop.RequestVerificationForWindowAsync(new IntPtr(hwnd), message, ref riid);
            }
            finally
            {
                if (ptr != IntPtr.Zero)
                {
                    Marshal.Release(ptr);
                }
            }
        }
    }
}
"@

  $activationFactory = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeMarshal]::GetActivationFactory($verifier)
  $asyncOperationGuid = [Guid]::Parse('fd596ffd-2318-558f-9dbe-d21df43764a5')
  $operation = [KoodoReaderInterop.UserConsentVerifierInteropHelper]::RequestVerificationForWindow($activationFactory, [Int64]::Parse($Hwnd), $Message, $asyncOperationGuid)
  return Invoke-WinRtAsync -Operation $operation -ResultTypes @([Windows.Security.Credentials.UI.UserConsentVerificationResult])
}

$verifier = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$availability = Invoke-WinRtAsync -Operation ($verifier::CheckAvailabilityAsync()) -ResultTypes @([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])

if ('${mode}' -eq 'check') {
  [Console]::Out.Write((@{
    available = ($availability.ToString() -eq 'Available')
    status = $availability.ToString()
  } | ConvertTo-Json -Compress))
  exit 0
}

if ($availability.ToString() -ne 'Available') {
  [Console]::Out.Write((@{
    success = $false
    code = 'Unavailable'
    status = $availability.ToString()
  } | ConvertTo-Json -Compress))
  exit 0
}

try {
  $result = Request-WindowsHelloVerification -Message '${escapedMessage}' -Hwnd '${escapedHwnd}'
  [Console]::Out.Write((@{
    success = ($result.ToString() -eq 'Verified')
    code = $result.ToString()
    status = $availability.ToString()
  } | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.Write((@{
    success = $false
    code = 'Error'
    status = $_.Exception.Message
  } | ConvertTo-Json -Compress))
}
`.trim();
};

const getBiometricCapability = async () => {
  if (process.platform === "darwin") {
    const available =
      typeof systemPreferences.canPromptTouchID === "function" &&
      systemPreferences.canPromptTouchID();
    return {
      available,
      provider: "Touch ID",
      platform: process.platform,
      status: available ? "Available" : "Unavailable",
    };
  }

  if (process.platform === "win32") {
    try {
      const output = await runPowerShellScript(getWindowsHelloScript("check"));
      const result = output ? JSON.parse(output) : {};
      return {
        available: !!result.available,
        provider: "Windows Hello",
        platform: process.platform,
        status: result.status || "Unavailable",
      };
    } catch (error) {
      return {
        available: false,
        provider: "Windows Hello",
        platform: process.platform,
        status: "Error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    available: false,
    provider: "Biometric",
    platform: process.platform,
    status: "Unsupported",
  };
};

const promptBiometricAuth = async (
  promptMessage = "Authenticate",
  owningWindow = null
) => {
  if (process.platform === "darwin") {
    const available =
      typeof systemPreferences.canPromptTouchID === "function" &&
      systemPreferences.canPromptTouchID();
    if (!available) {
      return {
        success: false,
        code: "Unavailable",
        provider: "Touch ID",
      };
    }

    try {
      await systemPreferences.promptTouchID(promptMessage);
      return {
        success: true,
        code: "Verified",
        provider: "Touch ID",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        code: /cancel/i.test(message) ? "Canceled" : "Failed",
        provider: "Touch ID",
      };
    }
  }

  if (process.platform === "win32") {
    try {
      const hwnd = getWindowHandleValue(owningWindow);
      const output = await runPowerShellScript(
        getWindowsHelloScript("verify", promptMessage, hwnd),
        120000
      );
      const result = output ? JSON.parse(output) : {};
      return {
        success: !!result.success,
        code:
          result.code === "Unavailable" && result.status
            ? result.status
            : result.code || "Error",
        provider: "Windows Hello",
      };
    } catch (error) {
      console.error("Biometric verification error:", error.message);
      return {
        success: false,
        code: "Error",
        provider: "Windows Hello",
      };
    }
  }

  return {
    success: false,
    code: "Unsupported",
    provider: "Biometric",
  };
};

// Discord Rich Presence setup
let discordRPCClient = null;
let discordRPCReady = false;
let discordRPCConnecting = false;
const DISCORD_CLIENT_ID = "1490863275074781305"; // Koodo Reader Discord App ID

function initDiscordRPC() {
  if (discordRPCConnecting || discordRPCReady) return Promise.resolve();
  discordRPCConnecting = true;
  return new Promise((resolve) => {
    try {
      const DiscordRPC = require("discord-rpc");
      DiscordRPC.register(DISCORD_CLIENT_ID);
      const client = new DiscordRPC.Client({ transport: "ipc" });
      client.on("ready", () => {
        console.info("Discord RPC connected");
        discordRPCClient = client;
        discordRPCReady = true;
        discordRPCConnecting = false;
        resolve();
      });
      client.login({ clientId: DISCORD_CLIENT_ID }).catch((err) => {
        console.warn("Discord RPC login failed:", err.message);
        discordRPCClient = null;
        discordRPCReady = false;
        discordRPCConnecting = false;
        resolve();
      });
    } catch (e) {
      console.warn("Discord RPC init failed:", e.message);
      discordRPCClient = null;
      discordRPCReady = false;
      discordRPCConnecting = false;
      resolve();
    }
  });
}
function destroyDiscordRPC() {
  if (discordRPCClient) {
    try {
      discordRPCClient.destroy();
    } catch (_) {}
    discordRPCClient = null;
  }
  discordRPCReady = false;
  discordRPCConnecting = false;
}
function buildProgressBar(percentage) {
  const total = 10;
  const filled = Math.round((percentage / 100) * total);
  const empty = total - filled;
  return "▓".repeat(filled) + "░".repeat(empty);
}

// Edge TTS Implementation - Fixed Version
const BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const SEC_MSGEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const WIN_EPOCH = 11644473600;
const S_TO_NS = 1e9;

const WSS_URL = `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const VOICE_LIST_URL = `https://${BASE_URL}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

class KerojiangTTSConnection {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.isReady = false;
    this.heartbeatTimer = null;
    this.idleTimer = null;
    this.messageHandlers = new Map();
    this.pendingRequests = new Map();
    this.requestIdCounter = 0;
    this.audioChunks = [];
    this.currentResolve = null;
    this.currentReject = null;
  }

  async connect() {
    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this;
    }

    return new Promise((resolve, reject) => {
      try {
        this._doConnect(resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  _doConnect(resolve, reject) {
    const headers = this._getHeaders();
    const secGEC = this._generateSecMSGEC();
    const connectionId = crypto.randomUUID().replace(/-/g, '');

    const wsURL = `${WSS_URL}&ConnectionId=${connectionId}&Sec-MS-GEC=${secGEC}&Sec-MS-GEC-Version=${SEC_MSGEC_VERSION}`;

    console.log('[Edge TTS] Connecting to WebSocket...');

    this.ws = new WebSocket(wsURL, {
      headers: headers,
      handshakeTimeout: 45000,
      followRedirects: true,
    });

    this.ws.on('open', () => {
      console.log('[Edge TTS] WebSocket connected');
      this.isConnected = true;
      this.isReady = false;

      // 发送配置命令
      const command = `X-Timestamp:${this._dateToString()}\r\n` +
        `Content-Type:application/json; charset=utf-8\r\n` +
        `Path:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;

      this.ws.send(command, (err) => {
        if (err) {
          console.error('[Edge TTS] Failed to send config:', err);
          reject(err);
        } else {
          console.log('[Edge TTS] Config sent, waiting for response...');
          // 配置发送后，等待response消息标记为ready
          setTimeout(() => {
            if (!this.isReady) {
              this.isReady = true;
              this._startHeartbeat();
              resolve(this);
            }
          }, 500);
        }
      });
    });

    this.ws.on('message', (data) => {
      this._resetIdleTimer();
      this._handleMessage(data);
    });

    this.ws.on('close', (code, reason) => {
      console.log('[Edge TTS] WebSocket closed:', code);
      this._cleanup();
      this.isConnected = false;
      this.isReady = false;
    });

    this.ws.on('error', (error) => {
      console.error('[Edge TTS] WebSocket error:', error.message);
      this._cleanup();
      this.isConnected = false;
      this.isReady = false;
      if (reject) reject(error);
    });

    // 连接超时
    setTimeout(() => {
      if (!this.isConnected) {
        this.ws?.terminate();
        reject(new Error('Connection timeout'));
      }
    }, 30000);
  }

  _handleMessage(data) {
    if (Buffer.isBuffer(data)) {
      // 二进制消息 - 音频数据
      this._handleBinaryMessage(data);
    } else {
      // 文本消息
      this._handleTextMessage(data.toString());
    }
  }

  _handleTextMessage(dataStr) {
    const separatorIndex = dataStr.indexOf('\r\n\r\n');
    if (separatorIndex === -1) return;

    const headerPart = dataStr.substring(0, separatorIndex);
    const msgData = dataStr.substring(separatorIndex + 4);
    const parameters = this._parseHeaders(headerPart);
    const msgPath = parameters['Path'];

    if (msgPath === 'response') {
      console.log('[Edge TTS] Service ready');
      this.isReady = true;
      this._startHeartbeat();
    } else if (msgPath === 'turn.end') {
      console.log('[Edge TTS] Turn ended');
      this._resolveCurrentRequest();
    } else if (msgPath === 'audio.metadata') {
      // 处理元数据（可选）
    }
  }

  _handleBinaryMessage(data) {
    if (data.length < 2) return;

    const headerLength = (data[0] << 8) | data[1];
    if (headerLength > data.length) return;

    const headerData = data.slice(0, headerLength);
    const msgData = data.slice(headerLength + 2);
    const parameters = this._parseHeaders(headerData.toString('latin1'));

    if (parameters['Path'] === 'audio' && parameters['Content-Type'] === 'audio/mpeg') {
      if (msgData.length > 0) {
        this.audioChunks.push(msgData);
      }
    }
  }

  _resolveCurrentRequest() {
    if (this.currentResolve && this.audioChunks.length > 0) {
      const audioBuffer = Buffer.concat(this.audioChunks);
      this.audioChunks = [];
      // 保存引用并清空，防止close事件再次触发
      const resolve = this.currentResolve;
      this.currentResolve = null;
      this.currentReject = null;
      resolve(audioBuffer);
    }
  }

  async synthesize(text, voiceName, rate, pitch, volume) {
    // 检查连接是否可用
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket connection not available');
    }

    return new Promise((resolve, reject) => {
      this.currentResolve = resolve;
      this.currentReject = reject;
      this.audioChunks = [];

      const requestId = crypto.randomUUID().replace(/-/g, '');
      const ssml = this._mkssml(voiceName, text, rate, pitch, volume);
      const request = this._ssmlHeadersPlusData(requestId, this._dateToString(), ssml);

      this.ws.send(request, (err) => {
        if (err) {
          console.error('[Edge TTS] Failed to send SSML:', err);
          this.currentReject = null;
          this.currentResolve = null;
          reject(err);
        } else {
          console.log('[Edge TTS] SSML sent, waiting for audio...');
        }
      });

      // 请求超时
      setTimeout(() => {
        if (this.currentReject) {
          this.currentReject(new Error('Synthesis timeout'));
          this.currentResolve = null;
          this.currentReject = null;
          this.audioChunks = [];
        }
      }, 30000);
    });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._resetIdleTimer();

    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        // 发送空的消息作为心跳
        try {
          this.ws.ping();
        } catch (error) {
          console.log('[Edge TTS] Heartbeat failed:', error.message);
        }
      }
    }, 30000);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _resetIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      console.log('[Edge TTS] Connection idle, closing...');
      this.close();
    }, 300000);
  }

  _cleanup() {
    this._stopHeartbeat();
    // 只有在请求还未完成时才reject
    if (this.currentReject && this.audioChunks.length === 0) {
      this.currentReject(new Error('Connection closed before audio received'));
      this.currentResolve = null;
      this.currentReject = null;
    } else if (this.audioChunks.length > 0 && this.currentResolve) {
      // 如果收到了音频但还没resolve
      const audioBuffer = Buffer.concat(this.audioChunks);
      this.audioChunks = [];
      const resolve = this.currentResolve;
      this.currentResolve = null;
      this.currentReject = null;
      console.log('[Edge TTS] Cleanup with received audio, resolving');
      resolve(audioBuffer);
    } else {
      // 请求已完成，只需清理
      this.currentResolve = null;
      this.currentReject = null;
      this.audioChunks = [];
    }
  }

  close() {
    this._cleanup();
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    this.isConnected = false;
    this.isReady = false;
  }

  // 辅助方法
  _generateSecMSGEC() {
    let ticks = Math.floor(Date.now() / 1000);
    ticks += WIN_EPOCH;
    ticks -= ticks % 300;
    ticks *= S_TO_NS / 100;
    const strToHash = `${Math.floor(ticks)}${TRUSTED_CLIENT_TOKEN}`;
    return crypto.createHash('sha256').update(strToHash).digest('hex').toUpperCase();
  }

  _getHeaders() {
    const chromiumMajorVersion = CHROMIUM_FULL_VERSION.split('.')[0];
    const muid = crypto.randomBytes(16).toString('hex').toUpperCase();
    return {
      'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumMajorVersion}.0.0.0 Safari/537.36 Edg/${chromiumMajorVersion}.0.0.0`,
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'en-US,en;q=0.9',
      'Pragma': 'no-cache',
      'Cache-Control': 'no-cache',
      'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'Sec-WebSocket-Version': '13',
      'Cookie': `muid=${muid};`,
    };
  }

  _dateToString() {
    return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
  }

  _mkssml(voice, text, rate, pitch, volume) {
    return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
      `<voice name='${voice}'>` +
      `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
      `${text}` +
      `</prosody>` +
      `</voice>` +
      `</speak>`;
  }

  _ssmlHeadersPlusData(requestId, timestamp, ssml) {
    return `X-RequestId:${requestId}\r\n` +
      `Content-Type:application/ssml+xml\r\n` +
      `X-Timestamp:${timestamp}Z\r\n` +
      `Path:ssml\r\n\r\n` +
      `${ssml}`;
  }

  _parseHeaders(data) {
    const headers = {};
    const lines = data.split('\r\n');
    for (const line of lines) {
      if (line.length === 0) continue;
      const parts = line.split(':');
      if (parts.length >= 2) {
        headers[parts[0].trim()] = parts.slice(1).join(':').trim();
      }
    }
    return headers;
  }
}

// KerojiangTTS 主类 - 管理连接池
class KerojiangTTS {
  constructor() {
    this.connection = null;
    this.useCount = 0;
  }

  // 获取连接
  // 注意：Edge TTS 服务在turn.end后关闭连接，所以每次都需要新连接
  async getConnection() {
    try {
      // 创建新连接（旧连接已被服务端关闭）
      this.connection = new KerojiangTTSConnection();
      await this.connection.connect();

      if (!this.connection || !this.connection.ws) {
        throw new Error('Connection was not established properly');
      }

      return this.connection;
    } catch (error) {
      console.error('[Edge TTS] getConnection failed:', error.message);
      this.connection = null;
      throw error;
    }
  }

  // 清理文本
  removeIncompatibleCharacters(text) {
    return text.split('').map(char => {
      const code = char.charCodeAt(0);
      if ((code >= 0 && code <= 8) || (code >= 11 && code <= 12) || (code >= 14 && code <= 31)) {
        return ' ';
      }
      return char;
    }).join('');
  }

  // HTML 转义
  escapeHTML(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 按句子分割文本
  splitTextBySentencesWithMaxLength(text, maxLength) {
    const textLen = Buffer.byteLength(text, 'utf8');
    if (textLen <= maxLength) {
      return [text];
    }

    const sentences = this.splitTextBySentences(text);
    const chunks = [];
    let currentChunk = '';

    for (const sentence of sentences) {
      const sentenceBytes = Buffer.byteLength(sentence, 'utf8');
      if (Buffer.byteLength(currentChunk + sentence, 'utf8') > maxLength && currentChunk.length > 0) {
        const chunk = currentChunk.trim();
        if (chunk.length > 0) chunks.push(chunk);
        currentChunk = '';
      }
      if (sentenceBytes > maxLength) {
        const words = sentence.split(/\s+/);
        for (const word of words) {
          if (Buffer.byteLength(currentChunk + word, 'utf8') > maxLength && currentChunk.length > 0) {
            const chunk = currentChunk.trim();
            if (chunk.length > 0) chunks.push(chunk);
            currentChunk = '';
          }
          currentChunk += word + ' ';
        }
      } else {
        currentChunk += sentence + ' ';
      }
    }

    const chunk = currentChunk.trim();
    if (chunk.length > 0) chunks.push(chunk);
    return chunks;
  }

  // 按句子分割
  splitTextBySentences(text) {
    if (text.length === 0) return [];
    const sentences = [];
    let currentSentence = '';
    const runes = Array.from(text);
    let i = 0;
    while (i < runes.length) {
      const r = runes[i];
      currentSentence += r;
      if (this.isSentenceEnding(r)) {
        let sentenceEnd = i;
        let j = i + 1;
        while (j < runes.length) {
          const nextRune = runes[j];
          if (this.isSentenceEnding(nextRune) || nextRune === ' ' || nextRune === '\t' || nextRune === '\n' || nextRune === '\r') {
            sentenceEnd = j;
            j++;
          } else break;
        }
        const sentence = currentSentence.trim();
        if (sentence.length > 0) sentences.push(sentence);
        currentSentence = '';
        i = sentenceEnd + 1;
      } else i++;
    }
    const remaining = currentSentence.trim();
    if (remaining.length > 0) sentences.push(remaining);
    return sentences;
  }

  isSentenceEnding(r) {
    return ['。', '！', '？', '.', '!', '?', ';', '；'].includes(r);
  }

  // 生成音频
  async generateAudio(text, voiceName, speed, outputDir, options = {}) {
    try {
      const { bookName = 'unknown', chapter = 0, part = 0 } = options;
      console.log('[Edge TTS] Generating audio:', { text: text.substring(0, 50), voiceName, speed, bookName, chapter, part });

      const cleanText = this.removeIncompatibleCharacters(text);
      const escapedText = this.escapeHTML(cleanText);
      const rate = speed > 1 ? `+${Math.round((speed - 1) * 100)}%` : `-${Math.round((1 - speed) * 100)}%`;
      const pitch = '+0Hz';
      const volume = '+0%';

      const textChunks = this.splitTextBySentencesWithMaxLength(escapedText, 4096);
      console.log('[Edge TTS] Text chunks:', textChunks.length);

      // 创建缓存目录（使用系统临时文件夹，支持 Windows/Mac/Linux）
      const cacheBaseDir = outputDir || path.join(app.getPath('temp'), "koodo-reader-tts");
      if (!fs.existsSync(cacheBaseDir)) fs.mkdirSync(cacheBaseDir, { recursive: true });

      // 生成文件名：书名-章节-部分.mp3
      // 清理书名中的非法字符
      const safeBookName = String(bookName)
        .replace(/[<>:"/\\|?*]/g, '_')  // 替换Windows非法字符
        .replace(/\s+/g, '-')           // 空格替换为连字符
        .substring(0, 50);              // 限制长度

      const audioPath = path.join(cacheBaseDir, `${safeBookName}-ch${chapter}-part${part}.mp3`);

      // 处理每个文本块（每个块都会创建新连接）
      const allAudioData = [];
      for (let i = 0; i < textChunks.length; i++) {
        console.log(`[Edge TTS] Processing chunk ${i + 1}/${textChunks.length}`);

        let connection;
        try {
          // 每次生成独立的连接实例，避免并发请求时共享 this.connection 导致竞争
          connection = new KerojiangTTSConnection();
          await connection.connect();
          if (!connection || !connection.ws) {
            throw new Error(`Connection was not established for chunk ${i + 1}`);
          }
        } catch (error) {
          console.error(`[Edge TTS] Failed to create connection for chunk ${i + 1}:`, error.message);
          throw new Error(`Connection failed for chunk ${i + 1}: ${error.message}`);
        }

        if (!connection) {
          throw new Error(`Connection is null for chunk ${i + 1}`);
        }

        try {
          const audioData = await connection.synthesize(textChunks[i], voiceName, rate, pitch, volume);
          allAudioData.push(audioData);
          console.log(`[Edge TTS] Chunk ${i + 1} done, size:`, audioData.length);
        } catch (error) {
          console.error(`[Edge TTS] Failed to synthesize chunk ${i + 1}:`, error.message);
          throw error;
        }
      }

      const mergedAudio = Buffer.concat(allAudioData);
      console.log('[Edge TTS] Merged audio size:', mergedAudio.length);
      fs.writeFileSync(audioPath, mergedAudio);
      console.log('[Edge TTS] Saved to:', audioPath);

      return audioPath;
    } catch (error) {
      console.error('[Edge TTS] Error generating audio:', error);
      throw error;
    }
  }

  // 获取语音列表
  async listVoices() {
    try {
      console.log('[Edge TTS] Fetching voice list...');
      const chromiumMajorVersion = CHROMIUM_FULL_VERSION.split('.')[0];
      const muid = crypto.randomBytes(16).toString('hex').toUpperCase();
      const headers = {
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumMajorVersion}.0.0.0 Safari/537.36 Edg/${chromiumMajorVersion}.0.0.0`,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        'Authority': 'speech.platform.bing.com',
        'Sec-CH-UA': `" Not;A Brand";v="99", "Microsoft Edge";v="${chromiumMajorVersion}", "Chromium";v="${chromiumMajorVersion}"`,
        'Sec-CH-UA-Mobile': '?0',
        'Accept': '*/*',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'Cookie': `muid=${muid};`,
      };

      // 设置超时
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(VOICE_LIST_URL, {
        headers,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Failed to fetch voices: ${response.status} ${response.statusText}`);
      }

      const voices = await response.json();
      console.log(`[Edge TTS] Raw voices count: ${voices.length}`);

      if (!Array.isArray(voices)) {
        throw new Error('Invalid voice list format received');
      }

      // 过滤语音：只显示中文和英文（英文只保留美国和英国）
      const filteredVoices = voices.filter(voice => {
        const locale = voice.Locale || '';
        // 中文全部保留
        if (locale.startsWith('zh-')) return true;
        // 英文只保留美国和英国
        if (locale === 'en-US' || locale === 'en-GB') return true;
        return false;
      });

      console.log(`[Edge TTS] Found ${voices.length} voices, filtered to ${filteredVoices.length} voices`);

      return filteredVoices.map(voice => ({
        name: voice.ShortName,
        locale: voice.Locale,
        lang: voice.Locale,
        displayName: voice.FriendlyName,
        FriendlyName: voice.FriendlyName,
        plugin: 'kerojiang-tts',
        gender: voice.Gender,
        voiceInfo: voice,
      }));
    } catch (error) {
      console.error('[Edge TTS] Failed to list voices:', error.message);
      // 返回空数组而不是抛出错误，让前端可以继续运行
      return [];
    }
  }

  close() {
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
  }
}

// 导出单例
const kerojiangTTS = new KerojiangTTS();

// Kerojiang TTS 语音列表缓存（避免重复网络请求）
let kerojiangCachedVoices = null;
let kerojiangCachedVoicesPromise = null;

// 获取缓存的语音列表
async function kerojiangGetCachedVoices() {
  // 如果已有缓存，直接返回
  if (kerojiangCachedVoices) {
    console.log('[KerojiangTTS] Returning cached voices, count:', kerojiangCachedVoices.length);
    return kerojiangCachedVoices;
  }
  
  // 如果正在请求中，等待该请求完成
  if (kerojiangCachedVoicesPromise) {
    console.log('[KerojiangTTS] Waiting for pending voices request...');
    return kerojiangCachedVoicesPromise;
  }
  
  // 首次请求，发起请求并缓存 Promise
  console.log('[KerojiangTTS] First time fetching voices, caching result...');
  kerojiangCachedVoicesPromise = kerojiangTTS.listVoices();
  
  try {
    const voices = await kerojiangCachedVoicesPromise;
    kerojiangCachedVoices = voices;
    console.log('[KerojiangTTS] Voices cached, count:', voices.length);
    return voices;
  } catch (error) {
    console.error('[KerojiangTTS] Failed to cache voices:', error.message);
    throw error;
  } finally {
    kerojiangCachedVoicesPromise = null;
  }
}

// 清除所有 Kerojiang TTS 缓存
const kerojiangClearAllTtsCache = () => {
  try {
    const audioDir = path.join(app.getPath('temp'), 'koodo-reader-tts');
    if (fs.existsSync(audioDir)) {
      const files = fs.readdirSync(audioDir);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(audioDir, file));
        } catch (error) {
          // 忽略删除失败的文件
        }
      }
      console.log('[Edge TTS] Cleared all cache files');
    }
  } catch (error) {
    console.error('[Edge TTS] Failed to clear cache:', error);
  }
};

// 清除指定书籍的 Kerojiang TTS 缓存
const kerojiangClearBookTtsCache = (bookName) => {
  try {
    const audioDir = path.join(app.getPath('temp'), 'koodo-reader-tts');
    if (fs.existsSync(audioDir) && bookName) {
      const files = fs.readdirSync(audioDir);
      for (const file of files) {
        if (file.includes(bookName)) {
          try {
            fs.unlinkSync(path.join(audioDir, file));
          } catch (error) {
            // 忽略删除失败的文件
          }
        }
      }
      console.log('[Edge TTS] Cleared cache for book:', bookName);
    }
  } catch (error) {
    console.error('[Edge TTS] Failed to clear book cache:', error);
  }
};

// 进程退出时清理资源
process.on('exit', () => {
  kerojiangTTS.close();
});

const singleInstance = app.requestSingleInstanceLock();
var filePath = null;
var pendingDeepLink = null;
if (process.platform != "darwin" && process.argv.length >= 2) {
  filePath = process.argv[1];
  // Check argv for a deep link URL (cold start)
  for (const arg of process.argv) {
    if (arg.startsWith("koodo-reader://")) {
      pendingDeepLink = arg;
      break;
    }
  }
}
log.transports.file.fileName = "debug.log";
log.transports.file.maxSize = 1024 * 1024; // 1MB
log.initialize();
store.set("appVersion", packageJson.version);
store.set("appPlatform", os.platform() + " " + os.release());
const mainWinDisplayScale = store.get("mainWinDisplayScale") || 1;
let options = {
  width: parseInt(store.get("mainWinWidth") || 1050) / mainWinDisplayScale,
  height: parseInt(store.get("mainWinHeight") || 660) / mainWinDisplayScale,
  x: parseInt(store.get("mainWinX")),
  y: parseInt(store.get("mainWinY")),
  backgroundColor:
    store.get("appSkin") === "night" ? "rgba(47, 52, 55, 1)" : "#fff",
  minWidth: 300,
  minHeight: 100,
  webPreferences: {
    webSecurity: false,
    nodeIntegration: true,
    contextIsolation: false,
    nativeWindowOpen: true,
    nodeIntegrationInSubFrames: false,
    allowRunningInsecureContent: false,
    enableRemoteModule: true,
    sandbox: false,
  },
};
const Database = require("better-sqlite3");
if (os.platform() === "linux") {
  options = Object.assign({}, options, {
    icon: path.join(__dirname, "./build/assets/icon.png"),
  });
}
// Single Instance Lock
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", (event, argv, workingDir) => {
    if (mainWin) {
      if (!mainWin.isVisible()) mainWin.show();
      mainWin.focus();
    }
    // Handle deep link passed via second-instance argv
    const deepLink = argv.find((arg) => arg.startsWith("koodo-reader://"));
    if (deepLink) {
      handleCallback(deepLink);
    }
  });
}
if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
  // Make sure the directory exists
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  fs.writeFileSync(
    path.join(dirPath, "log.json"),
    JSON.stringify({ filePath }),
    "utf-8"
  );
}
const getDBConnection = (dbName, storagePath, sqlStatement) => {
  if (!dbConnection[dbName]) {
    if (!fs.existsSync(path.join(storagePath, "config"))) {
      fs.mkdirSync(path.join(storagePath, "config"), { recursive: true });
    }
    dbConnection[dbName] = new Database(
      path.join(storagePath, "config", `${dbName}.db`),
      {}
    );
    dbConnection[dbName].pragma("journal_mode = WAL");
    dbConnection[dbName].exec(sqlStatement["createTableStatement"][dbName]);
    if (sqlStatement["migrateStatement"][dbName]) {
      let sqlList = sqlStatement["migrateStatement"][dbName];
      for (let sql of sqlList) {
        try {
          dbConnection[dbName].exec(sql);
        } catch (error) {}
      }
    }
  }
  return dbConnection[dbName];
};
const getSyncUtil = async (config, isUseCache = true) => {
  if (!isUseCache || !syncUtilCache[config.service]) {
    const { SyncUtil } = await import("./src/assets/lib/kookit-extra.min.mjs");
    syncUtilCache[config.service] = new SyncUtil(config.service, config);
  }
  return syncUtilCache[config.service];
};
const removeSyncUtil = (config) => {
  if (syncUtilCache[config.service]) {
    syncUtilCache[config.service].clearQueue();
    delete syncUtilCache[config.service];
  }
};
const getPickerUtil = async (config, isUseCache = true) => {
  if (!isUseCache || !pickerUtilCache[config.service]) {
    const { SyncUtil } = await import("./src/assets/lib/kookit-extra.min.mjs");
    pickerUtilCache[config.service] = new SyncUtil(config.service, config);
  }
  return pickerUtilCache[config.service];
};
const removePickerUtil = (config) => {
  if (pickerUtilCache[config.service]) {
    pickerUtilCache[config.service] = null;
  }
};
const getNativeThemeSource = (appSkin) => {
  if (appSkin === "night") {
    return "dark";
  }
  if (appSkin === "light") {
    return "light";
  }
  return "system";
};
const getNativeDarkColorStatus = () => {
  if (
    typeof electronNativeTheme.shouldUseDarkColorsForSystemIntegratedUI !==
    "undefined"
  ) {
    return electronNativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
  }
  return electronNativeTheme.shouldUseDarkColors;
};
const applyNativeThemeSource = (appSkin) => {
  if (process.type !== "browser") {
    return false;
  }
  electronNativeTheme.themeSource = getNativeThemeSource(appSkin);
  store.set("appSkin", appSkin || "system");
  return getNativeDarkColorStatus();
};
applyNativeThemeSource(store.get("appSkin"));
// Simple encryption function
const encrypt = (text, key) => {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i) ^ key.charCodeAt(i % key.length);
    result += String.fromCharCode(charCode);
  }
  return Buffer.from(result).toString("base64");
};

// Simple decryption function
const decrypt = (encryptedText, key) => {
  const buff = Buffer.from(encryptedText, "base64").toString();
  let result = "";
  for (let i = 0; i < buff.length; i++) {
    const charCode = buff.charCodeAt(i) ^ key.charCodeAt(i % key.length);
    result += String.fromCharCode(charCode);
  }
  return result;
};
// Helper to check if two rectangles intersect (for partial visibility)
const rectanglesIntersect = (rect1, rect2) => {
  return !(
    rect1.x + rect1.width <= rect2.x ||
    rect1.y + rect1.height <= rect2.y ||
    rect1.x >= rect2.x + rect2.width ||
    rect1.y >= rect2.y + rect2.height
  );
};

// Check if the window is at least partially visible on any display
const isWindowPartiallyVisible = (bounds) => {
  const displays = screen.getAllDisplays();
  for (const display of displays) {
    if (rectanglesIntersect(bounds, display.workArea)) {
      return true;
    }
  }
  return false;
};
const createTray = () => {
  let iconPath = isDev
    ? path.join(__dirname, "./public/assets/icon.png")
    : path.join(__dirname, "./build/assets/icon.png");
  let trayIcon = nativeImage.createFromPath(iconPath);
  if (os.platform() === "darwin") {
    trayIcon = trayIcon.resize({ width: 16, height: 16, quality: "best" });
    trayIcon.setTemplateImage(false);
  }
  tray = new Tray(trayIcon);
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open Koodo Reader",
      click: () => {
        if (mainWin) {
          mainWin.show();
          mainWin.focus();
        }
      },
    },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip("Koodo Reader");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => {
    if (mainWin) {
      mainWin.show();
      mainWin.focus();
    }
  });
};
const createMainWin = () => {
  const isMainWindVisible = isWindowPartiallyVisible({
    width: parseInt(store.get("mainWinWidth") || 1050) / mainWinDisplayScale,
    height: parseInt(store.get("mainWinHeight") || 660) / mainWinDisplayScale,
    x: parseInt(store.get("mainWinX")),
    y: parseInt(store.get("mainWinY")),
  });
  if (!isMainWindVisible) {
    delete options.x;
    delete options.y;
  }
  mainWin = new BrowserWindow(options);
  if (store.get("isAlwaysOnTop") === "yes") {
    mainWin.setAlwaysOnTop(true);
  }
  if (store.get("isAutoMaximizeWin") === "yes") {
    mainWin.maximize();
  }

  if (!isDev) {
    Menu.setApplicationMenu(null);
  }

  const urlLocation = isDev
    ? "http://localhost:3000"
    : `file://${path.join(__dirname, "./build/index.html")}`;
  mainWin.loadURL(urlLocation);
  // Handle deep link on cold start: wait for renderer to mount its IPC listeners
  mainWin.webContents.once("did-finish-load", () => {
    if (pendingDeepLink) {
      const link = pendingDeepLink;
      pendingDeepLink = null;
      // Give React time to register ipcRenderer listeners before dispatching
      setTimeout(() => handleCallback(link), 1500);
    }
  });
  mainWin.on("close", (event) => {
    if (!isQuitting && store.get("isMinimizeToTray") === "yes") {
      event.preventDefault();
      mainWin.hide();
      if (!tray) {
        createTray();
      }
      return;
    }
    if (mainWin && !mainWin.isDestroyed()) {
      let bounds = mainWin.getBounds();
      const currentDisplay = screen.getDisplayMatching(bounds);
      const primaryDisplay = screen.getPrimaryDisplay();
      if (bounds.width > 300 && bounds.height > 100) {
        store.set({
          mainWinWidth: bounds.width,
          mainWinHeight: bounds.height,
          mainWinX: mainWin.isMaximized() ? 0 : bounds.x,
          mainWinY: mainWin.isMaximized() ? 0 : bounds.y,
          mainWinDisplayScale:
            currentDisplay.scaleFactor / primaryDisplay.scaleFactor,
        });
      }
    }
    mainWin = null;
  });
  const syncMainViewBounds = () => {
    if (mainView) {
      if (!mainWin) return;
      let { width, height } = mainWin.getContentBounds();
      mainView.setBounds({ x: 0, y: 0, width: width, height: height });
    }
  };
  mainWin.on("resize", throttle(syncMainViewBounds));
  mainWin.on("maximize", () => {
    if (mainView) {
      let { width, height } = mainWin.getContentBounds();
      mainView.setBounds({ x: 0, y: 0, width: width, height: height });
    }
  });
  mainWin.on("unmaximize", () => {
    if (mainView) {
      let { width, height } = mainWin.getContentBounds();
      mainView.setBounds({ x: 0, y: 0, width: width, height: height });
    }
  });
  mainWin.on("focus", () => {
    if (mainView && !mainView.webContents.isDestroyed()) {
      mainView.webContents.focus();
    }
  });
  mainWin.webContents.on(
    "console-message",
    (event, level, message, line, sourceId) => {
      console.log(`[Renderer Console] Message: ${message}`);
    }
  );
  //cancel-download-app
  ipcMain.handle("cancel-download-app", (event, arg) => {
    // Implement cancellation logic here
    // Note: In this example, we are not keeping a reference to the request,
    // so we cannot actually abort it. This is a placeholder for demonstration.
    if (downloadRequest) {
      downloadRequest.abort();
      downloadRequest = null;
    }
    event.returnValue = "cancelled";
  });
  // Discord RPC handlers
  ipcMain.handle("discord-rpc-update", async (event, config) => {
    const { bookTitle, author, percentage } = config;
    if (!discordRPCReady) {
      await initDiscordRPC();
    }
    if (!discordRPCClient || !discordRPCReady) return;
    try {
      const progressBar = buildProgressBar(percentage);
      await discordRPCClient.setActivity({
        details: bookTitle,
        state: `${progressBar} ${percentage}%  |  by ${author}`,
        largeImageKey: "koodo_reader_logo",
        largeImageText: "Koodo Reader",
        startTimestamp: Date.now(),
        instance: false,
        buttons: [
          {
            label: "Get Koodo Reader",
            url: "https://koodoreader.com",
          },
        ],
      });
    } catch (e) {
      console.warn("Failed to set Discord activity:", e.message);
    }
  });
  ipcMain.handle("discord-rpc-clear", async (event) => {
    if (discordRPCClient) {
      try {
        await discordRPCClient.clearActivity();
      } catch (e) {
        console.warn("Failed to clear Discord activity:", e.message);
      }
    }
  });
  ipcMain.handle("update-win-app", (event, config) => {
    let fileName = `koodo-reader-installer.exe`;
    let supportedArchs = ["x64", "ia32", "arm64"];
    //get system arch
    let arch = os.arch();
    if (!supportedArchs.includes(arch)) {
      return;
    }

    let url = `https://dl.koodoreader.com/v${config.version}/Koodo-Reader-${config.version}-${arch}.exe`;
    const https = require("https");
    const { spawn } = require("child_process");
    const file = fs.createWriteStream(path.join(app.getPath("temp"), fileName));
    downloadRequest = https.get(url, (res) => {
      const totalSize = parseInt(res.headers["content-length"], 10);
      let downloadedSize = 0;
      res.on("data", (chunk) => {
        downloadedSize += chunk.length;
        const progress = ((downloadedSize / totalSize) * 100).toFixed(2);
        const downloadedMB = (downloadedSize / 1024 / 1024).toFixed(2);
        const totalMB = (totalSize / 1024 / 1024).toFixed(2);
        mainWin.webContents.send("download-app-progress", {
          progress,
          downloadedMB,
          totalMB,
        });
      });

      res.pipe(file);
      file.on("finish", () => {
        console.info("\n下载完成！");
        file.close();

        let updateExePath = path.join(app.getPath("temp"), fileName);
        if (!fs.existsSync(updateExePath)) {
          console.error("更新包不存在:", updateExePath);
          return;
        }
        // 验证文件可执行性
        try {
          fs.accessSync(updateExePath, fs.constants.X_OK);
          console.info("更新包可执行性验证通过");
        } catch (err) {
          console.error("更新包不可执行:", err.message);
          return;
        }
        try {
          // 先退出应用，再启动安装程序，避免文件锁定导致覆盖安装失败
          app.once("will-quit", () => {
            const child = spawn(updateExePath, [], {
              stdio: "ignore",
              detached: true,
              shell: true,
              windowsHide: false,
            });
            child.unref();
          });
          app.quit();
        } catch (err) {
          console.error(`spawn 执行异常: ${err.message}`);
        }
      });
    });
  });
  ipcMain.handle("open-book", (event, config) => {
    let { url, isMergeWord, isAutoFullscreen, isAutoMaximize, isPreventSleep } =
      config;
    if (isMergeWord) {
      delete options.backgroundColor;
    }
    store.set({
      url,
      isMergeWord: isMergeWord || "no",
      isAutoFullscreen: isAutoFullscreen || "no",
      isAutoMaximize: isAutoMaximize || "no",
      isPreventSleep: isPreventSleep || "no",
    });
    let id;
    if (isPreventSleep === "yes") {
      id = powerSaveBlocker.start("prevent-display-sleep");
      console.info(powerSaveBlocker.isStarted(id));
    }
    if (readerWindow) {
      readerWindowList.push(readerWindow);
    }
    if (isAutoFullscreen === "yes" || isAutoMaximize === "yes") {
      readerWindow = new BrowserWindow(options);
      readerWindow.loadURL(url);
      if (isAutoFullscreen === "yes") {
        readerWindow.setFullScreen(true);
      } else if (isAutoMaximize === "yes") {
        readerWindow.maximize();
      }
    } else {
      const scaleRatio = store.get("windowDisplayScale") || 1;
      const isWindowVisible = isWindowPartiallyVisible({
        x: parseInt(store.get("windowX")),
        y: parseInt(store.get("windowY")),
        width: parseInt(store.get("windowWidth") || 1050) / scaleRatio,
        height: parseInt(store.get("windowHeight") || 660) / scaleRatio,
      });
      readerWindow = new BrowserWindow({
        ...options,
        width: parseInt(store.get("windowWidth") || 1050) / scaleRatio,
        height: parseInt(store.get("windowHeight") || 660) / scaleRatio,
        x: isWindowVisible ? parseInt(store.get("windowX")) : undefined,
        y: isWindowVisible ? parseInt(store.get("windowY")) : undefined,
        frame: isMergeWord === "yes" ? false : true,
        hasShadow: isMergeWord === "yes" ? false : true,
        transparent: isMergeWord === "yes" ? true : false,
      });
      readerWindow.loadURL(url);
      // readerWindow.webContents.openDevTools();
    }
    if (store.get("isAlwaysOnTop") === "yes") {
      readerWindow.setAlwaysOnTop(true);
    }
    readerWindowReadyToClose = false;
    readerWindow.on("close", (event) => {
      // --- Step 1: ask renderer to flush reading-time data first ---
      if (
        !readerWindowReadyToClose &&
        readerWindow &&
        !readerWindow.isDestroyed()
      ) {
        event.preventDefault();
        readerWindow.webContents.send("before-reader-close");
        return;
      }
      // --- Step 2: actual close logic (reached after renderer replied) ---
      if (readerWindow && !readerWindow.isDestroyed()) {
        let bounds = readerWindow.getBounds();
        const currentDisplay = screen.getDisplayMatching(bounds);
        const primaryDisplay = screen.getPrimaryDisplay();
        if (bounds.width > 300 && bounds.height > 100) {
          store.set({
            windowWidth: bounds.width,
            windowHeight: bounds.height,
            windowX:
              readerWindow.isMaximized() &&
              currentDisplay.id === primaryDisplay.id
                ? 0
                : bounds.x,
            windowY:
              readerWindow.isMaximized() &&
              currentDisplay.id === primaryDisplay.id
                ? 0
                : bounds.y < 0
                  ? 0
                  : bounds.y,
            windowDisplayScale:
              currentDisplay.scaleFactor / primaryDisplay.scaleFactor,
          });
        }
      }
      if (isPreventSleep && !readerWindow.isDestroyed()) {
        id && powerSaveBlocker.stop(id);
      }
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send("reading-finished", {});
      }
      if (discordRPCClient) {
        try {
          discordRPCClient.clearActivity();
        } catch (e) {
          console.warn("Failed to clear Discord activity:", e.message);
        }
      }
    });
    // Renderer finished flushing reading-time data — proceed with actual close
    ipcMain.once("reader-close-ready", () => {
      if (readerWindow && !readerWindow.isDestroyed()) {
        readerWindowReadyToClose = true;
        readerWindow.close();
      }
    });

    event.returnValue = "success";
  });
  ipcMain.handle("generate-tts", async (event, voiceConfig) => {
    let { text, speed, plugin, config } = voiceConfig;
    let voiceFunc = plugin.script;
    // eslint-disable-next-line no-eval
    eval(voiceFunc);
    return global.getAudioPath(text, speed, dirPath, config);
  });

  ipcMain.handle("kerojiang-generate-tts", async (event, options) => {
    try {
      if (!options || typeof options !== 'object') {
        console.error('[Edge TTS IPC] Invalid options:', options);
        return null;
      }

      const { text, voiceName, speed, bookName, chapterIndex, part } = options;
      
      if (!text || typeof text !== 'string') {
        console.error('[Edge TTS IPC] Invalid text:', text);
        return null;
      }

      console.log('[Edge TTS IPC] Received request:', {
        textLength: text.length,
        voiceName: voiceName || DEFAULT_VOICE,
        speed: speed || 1.0,
        bookName: bookName || 'unknown',
        chapterIndex: chapterIndex || 0,
        part: part || 0
      });

      const outputDir = path.join(app.getPath('temp'), 'koodo-reader-tts');

      const audioPath = await kerojiangTTS.generateAudio(
        text,
        voiceName || DEFAULT_VOICE,
        speed || 1.0,
        outputDir,
        {
          bookName: bookName || 'unknown',
          chapter: chapterIndex || 0,
          part: part || 0
        }
      );

      console.log('[Edge TTS IPC] Generated audio:', audioPath);
      return audioPath;
    } catch (error) {
      console.error('[Edge TTS IPC] Generate audio failed:', error);
      console.error('[Edge TTS IPC] Error stack:', error.stack);
      return null;
    }
  });

  ipcMain.handle("kerojiang-list-tts-voices", async (event, options) => {
    try {
      // 使用缓存的语音列表，避免重复网络请求
      const voices = await kerojiangGetCachedVoices();
      return voices;
    } catch (error) {
      console.error('[Edge TTS IPC] List voices failed:', error);
      // 返回空数组而不是抛出错误，让前端可以继续运行
      return [];
    }
  });

  ipcMain.handle("kerojiang-clear-tts-audio", async (event, options = {}) => {
    try {
      const { bookName } = options;
      const audioDir = path.join(app.getPath('temp'), 'koodo-reader-tts');
      if (fs.existsSync(audioDir)) {
        if (bookName) {
          // 清理特定书籍的音频文件
          const files = fs.readdirSync(audioDir);
          for (const file of files) {
            if (file.includes(bookName)) {
              try {
                fs.unlinkSync(path.join(audioDir, file));
              } catch (error) {
                console.error('[Edge TTS IPC] Failed to delete file:', file, error);
              }
            }
          }
        } else {
          // 清理所有音频文件
          const files = fs.readdirSync(audioDir);
          for (const file of files) {
            try {
              fs.unlinkSync(path.join(audioDir, file));
            } catch (error) {
              console.error('[Edge TTS IPC] Failed to delete file:', file, error);
            }
          }
        }
      }
    } catch (error) {
      console.error('[Edge TTS IPC] Clear audio failed:', error);
    }
  });

  ipcMain.handle("cloud-upload", async (event, config) => {
    let syncUtil = await getSyncUtil(config, config.isUseCache);
    let result = await syncUtil.uploadFile(
      config.fileName,
      config.fileName,
      config.type
    );
    return result;
  });

  ipcMain.handle("cloud-download", async (event, config) => {
    let syncUtil = await getSyncUtil(config);
    let result = await syncUtil.downloadFile(
      config.fileName,
      (config.isTemp ? "temp-" : "") + config.fileName,
      config.type
    );
    return result;
  });
  ipcMain.handle("cloud-progress", async (event, config) => {
    let syncUtil = await getSyncUtil(config);
    let result = syncUtil.getDownloadedSize();
    return result;
  });
  ipcMain.handle("picker-download", async (event, config) => {
    let pickerUtil = await getPickerUtil(config);
    let result = await pickerUtil.remote.downloadFile(
      config.sourcePath,
      config.destPath
    );
    return result;
  });
  ipcMain.handle("picker-progress", async (event, config) => {
    let pickerUtil = await getPickerUtil(config);
    let result = await pickerUtil.getDownloadedSize();
    return result;
  });
  ipcMain.handle("cloud-reset", async (event, config) => {
    let syncUtil = await getSyncUtil(config);
    let result = syncUtil.resetCounters();
    return result;
  });
  ipcMain.handle("cloud-stats", async (event, config) => {
    let syncUtil = await getSyncUtil(config);
    let result = syncUtil.getStats();
    return result;
  });
  ipcMain.handle("cloud-delete", async (event, config) => {
    try {
      let syncUtil = await getSyncUtil(config, config.isUseCache);
      let result = await syncUtil.deleteFile(config.fileName, config.type);
      return result;
    } catch (error) {
      console.error("Error deleting file:", error);
    }
    return false;
  });

  ipcMain.handle("cloud-list", async (event, config) => {
    let syncUtil = await getSyncUtil(config);
    let result = await syncUtil.listFiles(config.type);
    return result;
  });
  ipcMain.handle("picker-list", async (event, config) => {
    let pickerUtil = await getPickerUtil(config);
    let result = await pickerUtil.listFileInfos(config.currentPath);
    return result;
  });
  ipcMain.handle("cloud-exist", async (event, config) => {
    let syncUtil = await getSyncUtil(config);
    let result = await syncUtil.isExist(config.fileName, config.type);
    return result;
  });
  ipcMain.handle("cloud-close", async (event, config) => {
    removeSyncUtil(config);
    return "pong";
  });

  ipcMain.handle("clear-tts", async (event, config) => {
    if (!fs.existsSync(path.join(dirPath, "tts"))) {
      return "pong";
    } else {
      const fsExtra = require("fs-extra");
      try {
        await fsExtra.remove(path.join(dirPath, "tts"));
        await fsExtra.mkdir(path.join(dirPath, "tts"));
        return "pong";
      } catch (err) {
        console.error(err);
        return "pong";
      }
    }
  });
  ipcMain.handle("select-path", async (event) => {
    var path = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    return path.filePaths[0];
  });
  ipcMain.handle("select-file", async (event, config) => {
    const dialogOptions = { properties: ["openFile"] };
    if (config && config.filters) {
      dialogOptions.filters = config.filters;
    }
    var result = await dialog.showOpenDialog(dialogOptions);
    return result.filePaths[0];
  });
  ipcMain.handle("encrypt-data", async (event, config) => {
    const { TokenService } =
      await import("./src/assets/lib/kookit-extra.min.mjs");
    let fingerprint = await TokenService.getFingerprint();
    let encrypted = encrypt(config.token, fingerprint);
    store.set("encryptedToken", encrypted);
    return "pong";
  });
  ipcMain.handle("decrypt-data", async (event) => {
    let encrypted = store.get("encryptedToken");
    if (!encrypted) return "";
    const { TokenService } =
      await import("./src/assets/lib/kookit-extra.min.mjs");
    let fingerprint = await TokenService.getFingerprint();
    let decrypted = decrypt(encrypted, fingerprint);
    if (decrypted.startsWith("{") && decrypted.endsWith("}")) {
      return decrypted;
    } else {
      try {
        const { safeStorage } = require("electron");
        decrypted = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
        let newEncrypted = encrypt(decrypted, fingerprint);
        store.set("encryptedToken", newEncrypted);
        return decrypted;
      } catch (error) {
        console.error("Decryption failed:", error);
        return "{}";
      }
    }
  });
  ipcMain.handle("check-cloud-url", async (event, config) => {
    const https = require("https");
    const http = require("http");
    const { URL } = require("url");
    const { url } = config;
    return new Promise((resolve) => {
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch (e) {
        return resolve({ ok: false, reason: "invalid_url", detail: e.message });
      }
      const isHttps = parsedUrl.protocol === "https:";
      const lib = isHttps ? https : http;
      const port = parsedUrl.port
        ? parseInt(parsedUrl.port)
        : isHttps
          ? 443
          : 80;
      const options = {
        hostname: parsedUrl.hostname,
        port,
        path: parsedUrl.pathname || "/",
        method: "HEAD",
        timeout: 8000,
        rejectUnauthorized: true,
      };
      const req = lib.request(options, (res) => {
        resolve({
          ok: true,
          status: res.statusCode,
          detail: `HTTP ${res.statusCode}`,
        });
      });
      req.on("timeout", () => {
        req.destroy();
        resolve({
          ok: false,
          reason: "timeout",
          detail: `Connection to ${parsedUrl.hostname}:${port} timed out after 8s`,
        });
      });
      req.on("error", (err) => {
        let reason = "unknown";
        if (err.code === "ENOTFOUND") {
          reason = "dns_failed";
        } else if (err.code === "ECONNREFUSED") {
          reason = "connection_refused";
        } else if (err.code === "ECONNRESET") {
          reason = "connection_reset";
        } else if (err.code === "ETIMEDOUT") {
          reason = "timeout";
        } else if (
          err.code === "CERT_HAS_EXPIRED" ||
          err.code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
          err.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
        ) {
          reason = "ssl_error";
        } else if (err.message && err.message.includes("SSL")) {
          reason = "ssl_error";
        }
        resolve({
          ok: false,
          reason,
          code: err.code || "",
          detail: err.message,
        });
      });
      req.end();
    });
  });
  ipcMain.handle("get-mac", async (event, config) => {
    const { machineIdSync } = require("node-machine-id");
    return machineIdSync();
  });
  ipcMain.handle("get-device-name", async () => {
    return os.hostname() || "";
  });
  ipcMain.handle("get-store-value", async (event, config) => {
    return store.get(config.key);
  });
  ipcMain.handle("get-biometric-capability", async () => {
    return await getBiometricCapability();
  });
  ipcMain.handle("prompt-biometric-auth", async (event, config) => {
    const senderWindow =
      BrowserWindow.fromWebContents(event.sender) ||
      BrowserWindow.getFocusedWindow() ||
      mainWin ||
      null;
    return await promptBiometricAuth(config?.message, senderWindow);
  });

  ipcMain.handle("reset-reader-position", async (event) => {
    store.delete("windowX");
    store.delete("windowY");
    return "success";
  });
  ipcMain.handle("reset-main-position", async (event) => {
    store.delete("mainWinX");
    store.delete("mainWinY");
    app.relaunch();
    app.exit();
    return "success";
  });

  ipcMain.handle("select-zip-file", async (event, config) => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Zip Files", extensions: ["zip"] }],
    });

    if (result.canceled) {
      return "";
    } else {
      const filePath = result.filePaths[0];
      return filePath;
    }
  });

  ipcMain.handle("select-book", async (event, config) => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Books",
          extensions: [
            "epub",
            "pdf",
            "txt",
            "mobi",
            "azw3",
            "azw",
            "htm",
            "html",
            "xml",
            "xhtml",
            "mhtml",
            "docx",
            "md",
            "fb2",
            "cbz",
            "cbt",
            "cbr",
            "cb7",
          ],
        },
      ],
    });

    if (result.canceled) {
      console.info("User canceled the file selection");
      return [];
    } else {
      const filePaths = result.filePaths;
      console.info("Selected file path:", filePaths);
      return filePaths;
    }
  });
  ipcMain.handle("custom-database-command", async (event, config) => {
    const { SqlStatement } =
      await import("./src/assets/lib/kookit-extra.min.mjs");
    let { query, storagePath, data, dbName, executeType } = config;
    let db = getDBConnection(dbName, storagePath, SqlStatement.sqlStatement);
    const row = db.prepare(query);
    let result;
    if (data && data.length > 0) {
      result = row[executeType](...data);
    } else {
      result = row[executeType]();
    }
    return result;
  });
  ipcMain.handle("database-command", async (event, config) => {
    const { SqlStatement } =
      await import("./src/assets/lib/kookit-extra.min.mjs");
    let { statement, statementType, executeType, dbName, data, storagePath } =
      config;
    let db = getDBConnection(dbName, storagePath, SqlStatement.sqlStatement);
    let sql = "";
    if (statementType === "string") {
      sql = SqlStatement.sqlStatement[statement][dbName];
    } else if (statementType === "function") {
      sql = SqlStatement.sqlStatement[statement][dbName](data);
    }
    const row = db.prepare(sql);
    let result;
    if (data) {
      if (statement.startsWith("save") || statement.startsWith("update")) {
        data = SqlStatement.jsonToSqlite[dbName](data);
      }
      result = row[executeType](data);
    } else {
      result = row[executeType]();
    }
    if (executeType === "all") {
      return result.map((item) => SqlStatement.sqliteToJson[dbName](item));
    } else if (executeType === "get") {
      return SqlStatement.sqliteToJson[dbName](result);
    } else {
      return result;
    }
  });
  ipcMain.handle("close-database", async (event, config) => {
    const { SqlStatement } =
      await import("./src/assets/lib/kookit-extra.min.mjs");
    let { dbName, storagePath } = config;
    let db = getDBConnection(dbName, storagePath, SqlStatement.sqlStatement);
    delete dbConnection[dbName];
    // Flush WAL into the main .db file and flip to rollback journal mode so the
    // on-disk file is self-contained (header read/write version = 1, no -wal
    // dependency). Other consumers — e.g. the Expo app's expo-sqlite
    // deserializeDatabaseAsync — can only open a non-WAL SQLite image; without
    // this, backups restored there fail with "unable to open database file".
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.pragma("journal_mode = DELETE");
    } catch (error) {
      console.error("failed to checkpoint/switch journal mode:", error);
    }
    db.close();
  });
  ipcMain.handle("set-always-on-top", async (event, config) => {
    store.set("isAlwaysOnTop", config.isAlwaysOnTop);
    if (mainWin && !mainWin.isDestroyed()) {
      if (config.isAlwaysOnTop === "yes") {
        mainWin.setAlwaysOnTop(true);
      } else {
        mainWin.setAlwaysOnTop(false);
      }
    }
    if (readerWindow && !readerWindow.isDestroyed()) {
      if (config.isAlwaysOnTop === "yes") {
        readerWindow.setAlwaysOnTop(true);
      } else {
        readerWindow.setAlwaysOnTop(false);
      }
    }
    return "pong";
  });
  ipcMain.handle("set-auto-maximize", async (event, config) => {
    store.set("isAutoMaximizeWin", config.isAutoMaximizeWin);
    if (mainWin && !mainWin.isDestroyed()) {
      if (config.isAutoMaximizeWin === "yes") {
        mainWin.maximize();
      } else {
        mainWin.unmaximize();
      }
    }
    if (readerWindow && !readerWindow.isDestroyed()) {
      if (config.isAlwaysOnTop === "yes") {
        readerWindow.setAlwaysOnTop(true);
      } else {
        readerWindow.setAlwaysOnTop(false);
      }
    }
    return "pong";
  });
  ipcMain.handle("toggle-auto-launch", async (event, config) => {
    app.setLoginItemSettings({
      openAtLogin: config.isAutoLaunch === "yes",
    });
    return "pong";
  });
  ipcMain.handle("toggle-minimize-to-tray", async (event, config) => {
    store.set("isMinimizeToTray", config.isMinimizeToTray);
    if (config.isMinimizeToTray === "no" && tray) {
      tray.destroy();
      tray = null;
    }
    return "pong";
  });
  ipcMain.handle("open-explorer-folder", async (event, config) => {
    const { shell } = require("electron");
    if (config.isFolder) {
      shell.openPath(config.path);
    } else {
      shell.showItemInFolder(config.path);
    }

    return "pong";
  });
  ipcMain.handle("get-debug-logs", async (event, config) => {
    const { shell } = require("electron");
    const file = log.transports.file.getFile();
    shell.showItemInFolder(file.path);
    return "pong";
  });

  ipcMain.on("user-data", (event, arg) => {
    event.returnValue = dirPath;
  });
  ipcMain.handle("hide-reader", (event, arg) => {
    if (
      readerWindow &&
      !readerWindow.isDestroyed() &&
      readerWindow.isFocused()
    ) {
      readerWindow.minimize();
      event.returnvalue = true;
    } else if (mainWin && mainWin.isFocused()) {
      mainWin.minimize();
      event.returnvalue = true;
    } else {
      event.returnvalue = false;
    }
  });
  ipcMain.handle("open-console", (event, arg) => {
    mainWin.webContents.openDevTools();
    event.returnvalue = true;
  });
  ipcMain.handle("reload-reader", (event, arg) => {
    if (readerWindowList.length > 0) {
      readerWindowList.forEach((win) => {
        if (
          win &&
          !win.isDestroyed() &&
          win.webContents.getURL().indexOf(arg.bookKey) > -1
        ) {
          win.reload();
        }
      });
    }
    if (
      readerWindow &&
      !readerWindow.isDestroyed() &&
      readerWindow.webContents.getURL().indexOf(arg.bookKey) > -1
    ) {
      readerWindow.reload();
    }
  });
  ipcMain.handle("reload-main", (event, arg) => {
    if (mainWin) {
      mainWin.reload();
    }
  });

  ipcMain.handle("new-chat", (event, config) => {
    if (!chatWindow && mainWin) {
      let bounds = mainWin.getBounds();
      chatWindow = new BrowserWindow({
        ...options,
        width: 450,
        height: bounds.height,
        x: bounds.x + (bounds.width - 450),
        y: bounds.y,
        frame: true,
        hasShadow: true,
        transparent: false,
        webPreferences: {
          ...options.webPreferences,
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, "preload.js"),
        },
      });
      chatWindow.loadURL(config.url);
      chatWindow.on("close", (event) => {
        chatWindow && chatWindow.destroy();
        chatWindow = null;
      });
    } else if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.show();
      chatWindow.focus();
    }
  });
  ipcMain.on("chat-message", (event, msg) => {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send("chat-message", msg);
    }
  });
  ipcMain.handle("clear-all-data", (event, config) => {
    store.clear();
  });
  ipcMain.handle("new-tab", (event, config) => {
    if (mainWin) {
      mainView = new WebContentsView(options);
      mainWin.contentView.addChildView(mainView);
      let { width, height } = mainWin.getContentBounds();
      mainView.setBounds({ x: 0, y: 0, width: width, height: height });
      mainView.webContents.loadURL(config.url);
    }
  });
  ipcMain.handle("reload-tab", (event, config) => {
    if (mainWin && mainView) {
      mainView.webContents.reload();
    }
  });
  ipcMain.handle("adjust-tab-size", (event, config) => {
    if (mainWin && mainView) {
      let { width, height } = mainWin.getContentBounds();
      mainView.setBounds({ x: 0, y: 0, width: width, height: height });
    }
  });
  ipcMain.handle("exit-tab", (event, message) => {
    return new Promise((resolve) => {
      const doRemoveTab = () => {
        if (mainWin && mainView) {
          mainWin.contentView.removeChildView(mainView);
        }
        if (discordRPCClient) {
          try {
            discordRPCClient.clearActivity();
          } catch (e) {
            console.warn("Failed to clear Discord activity:", e.message);
          }
        }
        resolve(undefined);
      };

      // Ask the tab renderer to flush reading-time data first, then close
      if (mainView && !mainView.webContents.isDestroyed()) {
        const timeoutId = setTimeout(() => {
          // Fallback: if renderer doesn't reply within 3s, close anyway
          ipcMain.removeListener("tab-close-ready", onTabCloseReady);
          doRemoveTab();
        }, 3000);
        const onTabCloseReady = () => {
          clearTimeout(timeoutId);
          doRemoveTab();
        };
        ipcMain.once("tab-close-ready", onTabCloseReady);
        mainView.webContents.send("before-tab-close");
      } else {
        doRemoveTab();
      }
    });
  });
  ipcMain.handle("enter-tab-fullscreen", () => {
    if (mainWin && mainView) {
      mainWin.setFullScreen(true);
      console.info("enter full");
    }
  });
  ipcMain.handle("exit-tab-fullscreen", () => {
    if (mainWin && mainView) {
      mainWin.setFullScreen(false);
      console.info("exit full");
    }
  });
  ipcMain.handle("enter-fullscreen", () => {
    if (readerWindow) {
      readerWindow.setFullScreen(true);
      console.info("enter full");
    }
  });
  ipcMain.handle("exit-fullscreen", () => {
    if (readerWindow && !readerWindow.isDestroyed()) {
      readerWindow.setFullScreen(false);
      console.info("exit full");
    }
  });
  ipcMain.handle("open-url", async (event, config) => {
    if (config.type === "dict") {
      if (!dictWindow || dictWindow.isDestroyed()) {
        dictWindow = new BrowserWindow();
      }
      dictWindow.focus();
      await loadUrlInAuxWindow(dictWindow, config.url);
    } else if (config.type === "trans") {
      if (!transWindow || transWindow.isDestroyed()) {
        transWindow = new BrowserWindow();
      }
      transWindow.focus();
      await loadUrlInAuxWindow(transWindow, config.url);
    } else {
      if (!linkWindow || linkWindow.isDestroyed()) {
        linkWindow = new BrowserWindow();
      }
      linkWindow.loadURL(config.url);
      linkWindow.focus();
    }

    event.returnvalue = true;
  });
  ipcMain.handle("switch-moyu", (event, arg) => {
    let id;
    if (store.get("isPreventSleep") === "yes") {
      id = powerSaveBlocker.start("prevent-display-sleep");
      console.info(powerSaveBlocker.isStarted(id));
    }
    if (readerWindow && !readerWindow.isDestroyed()) {
      readerWindowReadyToClose = true;
      readerWindow.close();
      if (store.get("isMergeWord") === "yes") {
        delete options.backgroundColor;
      }
      const scaleRatio = store.get("windowDisplayScale") || 1;
      Object.assign(options, {
        width: parseInt(store.get("windowWidth") || 1050) / scaleRatio,
        height: parseInt(store.get("windowHeight") || 660) / scaleRatio,
        x: parseInt(store.get("windowX")),
        y: parseInt(store.get("windowY")),
        frame: store.get("isMergeWord") !== "yes" ? false : true,
        hasShadow: store.get("isMergeWord") !== "yes" ? false : true,
        transparent: store.get("isMergeWord") !== "yes" ? true : false,
      });

      store.set(
        "isMergeWord",
        store.get("isMergeWord") !== "yes" ? "yes" : "no"
      );
      if (readerWindow) {
        readerWindowList.push(readerWindow);
      }
      readerWindow = new BrowserWindow(options);
      if (store.get("isAlwaysOnTop") === "yes") {
        readerWindow.setAlwaysOnTop(true);
      }

      readerWindow.loadURL(store.get("url"));
      readerWindowReadyToClose = false;
      readerWindow.on("close", (event) => {
        // --- Step 1: ask renderer to flush reading-time data first ---
        if (
          !readerWindowReadyToClose &&
          readerWindow &&
          !readerWindow.isDestroyed()
        ) {
          event.preventDefault();
          readerWindow.webContents.send("before-reader-close");
          return;
        }
        // --- Step 2: actual close logic (reached after renderer replied) ---
        if (!readerWindow.isDestroyed()) {
          let bounds = readerWindow.getBounds();
          const currentDisplay = screen.getDisplayMatching(bounds);
          const primaryDisplay = screen.getPrimaryDisplay();
          if (bounds.width > 300 && bounds.height > 100) {
            store.set({
              windowWidth: bounds.width,
              windowHeight: bounds.height,
              windowX:
                readerWindow.isMaximized() &&
                currentDisplay.id === primaryDisplay.id
                  ? 0
                  : bounds.x,
              windowY:
                readerWindow.isMaximized() &&
                currentDisplay.id === primaryDisplay.id
                  ? 0
                  : bounds.y < 0
                    ? 0
                    : bounds.y,
            });
          }
        }
        if (store.get("isPreventSleep") && !readerWindow.isDestroyed()) {
          id && powerSaveBlocker.stop(id);
        }
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send("reading-finished", {});
        }
        if (discordRPCClient) {
          try {
            discordRPCClient.clearActivity();
          } catch (e) {
            console.warn("Failed to clear Discord activity:", e.message);
          }
        }
      });
      // Renderer finished flushing reading-time data — proceed with actual close
      ipcMain.once("reader-close-ready", () => {
        if (readerWindow && !readerWindow.isDestroyed()) {
          readerWindowReadyToClose = true;
          readerWindow.close();
        }
      });
    }
    event.returnvalue = false;
  });
  ipcMain.on("storage-location", (event, config) => {
    event.returnValue = path.join(dirPath, "data");
  });
  ipcMain.on("url-window-status", (event, config) => {
    if (config.type === "dict") {
      event.returnValue =
        dictWindow && !dictWindow.isDestroyed() ? true : false;
    } else if (config.type === "trans") {
      event.returnValue =
        transWindow && !transWindow.isDestroyed() ? true : false;
    } else {
      event.returnValue =
        linkWindow && !linkWindow.isDestroyed() ? true : false;
    }
  });
  ipcMain.on("get-dirname", (event, arg) => {
    event.returnValue = __dirname;
  });
  ipcMain.on("system-color", (event, arg) => {
    event.returnValue = getNativeDarkColorStatus() || false;
  });
  ipcMain.handle("set-native-theme-source", (event, appSkin) => {
    return applyNativeThemeSource(appSkin);
  });
  ipcMain.on("check-main-open", (event, arg) => {
    event.returnValue = mainWin ? true : false;
  });
  ipcMain.on("get-file-data", function (event) {
    if (fs.existsSync(path.join(dirPath, "log.json"))) {
      try {
        const _data = JSON.parse(
          fs.readFileSync(path.join(dirPath, "log.json"), "utf-8") || "{}"
        );
        if (_data && _data.filePath) {
          filePath = _data.filePath;
          setTimeout(() => {
            fs.writeFileSync(path.join(dirPath, "log.json"), "{}", "utf-8");
          }, 1000);
        }
      } catch (error) {
        console.error("Error reading log.json:", error);
      }
    }

    event.returnValue = filePath;
    filePath = null;
  });
  ipcMain.on("check-file-data", function (event) {
    if (fs.existsSync(path.join(dirPath, "log.json"))) {
      try {
        const _data = JSON.parse(
          fs.readFileSync(path.join(dirPath, "log.json"), "utf-8") || "{}"
        );
        if (_data && _data.filePath) {
          filePath = _data.filePath;
        }
      } catch (error) {
        console.error("Error reading log.json:", error);
      }
    }

    event.returnValue = filePath;
    filePath = null;
  });
  ipcMain.handle("system-ocr", async (event, config) => {
    const { base64, lang } = config || {};
    let tempPath = null;
    try {
      const { buffer, ext } = parseOcrImageInput(base64);
      tempPath = writeOcrTempImage(buffer, ext);
      const { macos, win } = resolveOcrLang(lang);
      let text = "";
      if (process.platform === "darwin") {
        text = await runMacosOcr(tempPath, macos);
      } else if (process.platform === "win32") {
        text = await runWindowsOcr(tempPath, win);
      } else {
        return {
          ok: false,
          error: "System OCR is only supported on Windows and macOS",
        };
      }
      return { ok: true, text };
    } catch (error) {
      log.error("system-ocr failed:", error.message);
      return { ok: false, error: error.message || "OCR failed" };
    } finally {
      if (tempPath) {
        try {
          fs.unlinkSync(tempPath);
        } catch (e) {
          // 忽略清理失败
        }
      }
    }
  });
};

app.on("ready", () => {
  // 程序启动时清除所有 Kerojiang TTS 缓存
  kerojiangClearAllTtsCache();
  createMainWin();
});
app.on("before-quit", () => {
  isQuitting = true;
  destroyDiscordRPC();
  // 程序关闭时清除所有 Kerojiang TTS 缓存
  kerojiangClearAllTtsCache();
});
app.on("window-all-closed", () => {
  app.quit();
});
app.on("open-file", (e, pathToFile) => {
  filePath = pathToFile;
});
// Register protocol handler
app.setAsDefaultProtocolClient("koodo-reader");
const serializeArg = (arg) => {
  if (arg === null) return "null";
  if (arg === undefined) return "undefined";
  if (typeof arg === "object") {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
};
const originalConsoleLog = console.log;
console.log = function (...args) {
  originalConsoleLog(...args); // 保留原日志
  try {
    log.info(args.map(serializeArg).join(" ")); // 写入日志文件
  } catch (e) {
    // 忽略日志写入错误（如 EPIPE 错误）
  }
};
const originalConsoleError = console.error;
console.error = function (...args) {
  originalConsoleError(...args); // 保留原错误日志
  try {
    log.error(args.map(serializeArg).join(" ")); // 写入错误日志文件
  } catch (e) {
    // 忽略日志写入错误
  }
};
const originalConsoleWarn = console.warn;
console.warn = function (...args) {
  originalConsoleWarn(...args); // 保留原警告日志
  try {
    log.warn(args.map(serializeArg).join(" ")); // 写入警告日志文件
  } catch (e) {
    // 忽略日志写入错误
  }
};
const originalConsoleInfo = console.info;
console.info = function (...args) {
  originalConsoleInfo(...args); // 保留原信息日志
  try {
    log.info(args.map(serializeArg).join(" ")); // 写入信息日志文件
  } catch (e) {
    // 忽略日志写入错误
  }
};
// Handle MacOS deep linking
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleCallback(url);
});
const handleCallback = (url) => {
  try {
    // 检查 URL 是否有效
    if (!url.startsWith("koodo-reader://")) {
      console.error("Invalid URL format:", url);
      return;
    }

    // 解析 URL
    const parsedUrl = new URL(url);
    const code = parsedUrl.searchParams.get("code");
    const state = parsedUrl.searchParams.get("state");
    const pickerData = parsedUrl.searchParams.get("pickerData");

    const bookKey = parsedUrl.searchParams.get("bookKey");
    const noteKey = parsedUrl.searchParams.get("noteKey");
    const importUrl = parsedUrl.searchParams.get("importUrl");

    if (code && mainWin) {
      mainWin.webContents.send("oauth-callback", { code, state });
    }
    if (pickerData && mainWin) {
      let config = JSON.parse(decodeURIComponent(pickerData));
      mainWin.webContents.send("picker-finished", config);
    }
    if (bookKey && mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
      mainWin.webContents.send("open-book-from-link", { bookKey });
    }
    if (noteKey && mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
      mainWin.webContents.send("open-note-from-link", { noteKey });
    }
    if (importUrl && mainWin) {
      const decodedUrl = decodeURIComponent(importUrl);
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
      mainWin.webContents.send("import-url-from-link", { url: decodedUrl });
    }
  } catch (error) {
    console.error("Error handling callback URL:", error);
    console.info("Problematic URL:", url);
  }
};
