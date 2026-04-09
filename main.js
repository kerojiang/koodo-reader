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
  nativeTheme,
  protocol,
  screen,
} = require("electron");
const WebSocket = require('ws');
const crypto = require('crypto');
const path = require("path");
const isDev = require("electron-is-dev");
const Store = require("electron-store");
const log = require("electron-log/main");
const os = require("os");
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
let chatWindow;
let dbConnection = {};
let syncUtilCache = {};
let pickerUtilCache = {};
let downloadRequest = null;

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
        console.log("Discord RPC connected");
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

class EdgeTTSConnection {
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

// EdgeTTS 主类 - 管理连接池
class EdgeTTS {
  constructor() {
    this.connection = null;
    this.useCount = 0;
  }

  // 获取连接
  // 注意：Edge TTS 服务在turn.end后关闭连接，所以每次都需要新连接
  async getConnection() {
    try {
      // 创建新连接（旧连接已被服务端关闭）
      this.connection = new EdgeTTSConnection();
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
          connection = new EdgeTTSConnection();
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
        plugin: 'edge-tts',
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
const edgeTTS = new EdgeTTS();

// Edge TTS 语音列表缓存（避免重复网络请求）
let cachedEdgeTTSVoices = null;
let cachedEdgeTTSVoicesPromise = null;

// 获取缓存的语音列表
async function getCachedEdgeTTSVoices() {
  // 如果已有缓存，直接返回
  if (cachedEdgeTTSVoices) {
    console.log('[Edge TTS] Returning cached voices, count:', cachedEdgeTTSVoices.length);
    return cachedEdgeTTSVoices;
  }
  
  // 如果正在请求中，等待该请求完成
  if (cachedEdgeTTSVoicesPromise) {
    console.log('[Edge TTS] Waiting for pending voices request...');
    return cachedEdgeTTSVoicesPromise;
  }
  
  // 首次请求，发起请求并缓存 Promise
  console.log('[Edge TTS] First time fetching voices, caching result...');
  cachedEdgeTTSVoicesPromise = edgeTTS.listVoices();
  
  try {
    const voices = await cachedEdgeTTSVoicesPromise;
    cachedEdgeTTSVoices = voices;
    console.log('[Edge TTS] Voices cached, count:', voices.length);
    return voices;
  } catch (error) {
    console.error('[Edge TTS] Failed to cache voices:', error.message);
    throw error;
  } finally {
    cachedEdgeTTSVoicesPromise = null;
  }
}

// 清除所有 Edge TTS 缓存
const clearAllEdgeTTSCache = () => {
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

// 清除指定书籍的 Edge TTS 缓存
const clearBookEdgeTTSCache = (bookName) => {
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
  edgeTTS.close();
});

const singleInstance = app.requestSingleInstanceLock();
var filePath = null;
if (process.platform != "darwin" && process.argv.length >= 2) {
  filePath = process.argv[1];
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
  backgroundColor: "#fff",
  minWidth: 400,
  minHeight: 300,
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
  delete syncUtilCache[config.service];
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
  const iconPath = isDev
    ? path.join(__dirname, "./public/assets/icon.png")
    : path.join(__dirname, "./build/assets/icon.png");
  tray = new Tray(nativeImage.createFromPath(iconPath));
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
      if (bounds.width > 0 && bounds.height > 0) {
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
  mainWin.on("resize", () => {
    if (mainView) {
      if (!mainWin) return;
      let { width, height } = mainWin.getContentBounds();
      mainView.setBounds({ x: 0, y: 0, width: width, height: height });
    }
  });
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
        console.log("\n下载完成！");
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
    options.webPreferences.nodeIntegrationInSubFrames = true;
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
      console.log(powerSaveBlocker.isStarted(id));
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
    readerWindow.on("close", (event) => {
      if (readerWindow && !readerWindow.isDestroyed()) {
        let bounds = readerWindow.getBounds();
        const currentDisplay = screen.getDisplayMatching(bounds);
        const primaryDisplay = screen.getPrimaryDisplay();
        if (bounds.width > 0 && bounds.height > 0) {
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

  ipcMain.handle("generate-edge-tts", async (event, options) => {
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

      const audioPath = await edgeTTS.generateAudio(
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

  ipcMain.handle("list-edge-tts-voices", async (event, options) => {
    try {
      // 使用缓存的语音列表，避免重复网络请求
      const voices = await getCachedEdgeTTSVoices();
      return voices;
    } catch (error) {
      console.error('[Edge TTS IPC] List voices failed:', error);
      // 返回空数组而不是抛出错误，让前端可以继续运行
      return [];
    }
  });

  ipcMain.handle("clear-edge-tts-audio", async (event, options = {}) => {
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
  ipcMain.handle("get-store-value", async (event, config) => {
    return store.get(config.key);
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

  ipcMain.handle("select-file", async (event, config) => {
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
      console.log("User canceled the file selection");
      return [];
    } else {
      const filePaths = result.filePaths;
      console.log("Selected file path:", filePaths);
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
    if (mainWin && mainView) {
      mainWin.contentView.removeChildView(mainView);
    }
  });
  ipcMain.handle("enter-tab-fullscreen", () => {
    if (mainWin && mainView) {
      mainWin.setFullScreen(true);
      console.log("enter full");
    }
  });
  ipcMain.handle("exit-tab-fullscreen", () => {
    if (mainWin && mainView) {
      mainWin.setFullScreen(false);
      console.log("exit full");
    }
  });
  ipcMain.handle("enter-fullscreen", () => {
    if (readerWindow) {
      readerWindow.setFullScreen(true);
      console.log("enter full");
    }
  });
  ipcMain.handle("exit-fullscreen", () => {
    if (readerWindow) {
      readerWindow.setFullScreen(false);
      console.log("exit full");
    }
  });
  ipcMain.handle("open-url", (event, config) => {
    if (config.type === "dict") {
      if (!dictWindow || dictWindow.isDestroyed()) {
        dictWindow = new BrowserWindow();
      }
      dictWindow.loadURL(config.url);
      dictWindow.focus();
    } else if (config.type === "trans") {
      if (!transWindow || transWindow.isDestroyed()) {
        transWindow = new BrowserWindow();
      }
      transWindow.loadURL(config.url);
      transWindow.focus();
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
      console.log(powerSaveBlocker.isStarted(id));
    }
    if (readerWindow) {
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
      options.webPreferences.nodeIntegrationInSubFrames = true;

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
      readerWindow.on("close", (event) => {
        if (!readerWindow.isDestroyed()) {
          let bounds = readerWindow.getBounds();
          const currentDisplay = screen.getDisplayMatching(bounds);
          const primaryDisplay = screen.getPrimaryDisplay();
          if (bounds.width > 0 && bounds.height > 0) {
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
    event.returnValue = nativeTheme.shouldUseDarkColors || false;
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
};

app.on("ready", () => {
  // 程序启动时清除所有 Edge TTS 缓存
  clearAllEdgeTTSCache();
  createMainWin();
});
app.on("before-quit", () => {
  isQuitting = true;
  destroyDiscordRPC();
  // 程序关闭时清除所有 Edge TTS 缓存
  clearAllEdgeTTSCache();
});
app.on("window-all-closed", () => {
  app.quit();
});
app.on("open-file", (e, pathToFile) => {
  filePath = pathToFile;
});
// Register protocol handler
app.setAsDefaultProtocolClient("koodo-reader");
// Handle deep linking
app.on("second-instance", (event, commandLine) => {
  const url = commandLine.pop();
  if (url) {
    handleCallback(url);
  }
});
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

    if (code && mainWin) {
      mainWin.webContents.send("oauth-callback", { code, state });
    }
    if (pickerData && mainWin) {
      let config = JSON.parse(decodeURIComponent(pickerData));
      mainWin.webContents.send("picker-finished", config);
    }
  } catch (error) {
    console.error("Error handling callback URL:", error);
    console.log("Problematic URL:", url);
  }
};
