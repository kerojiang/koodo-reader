// Edge TTS 服务初始化模块
// 在应用启动时调用，后台检查服务并缓存语音列表

class EdgeTTSService {
  private initialized: boolean = false;
  private available: boolean = false;
  private voices: any[] = [];
  private languages: string[] = [];
  private initPromise: Promise<void> | null = null;

  // 应用启动时调用，后台初始化
  async init(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._doInit();
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      console.log('[EdgeTTS Service] 开始初始化...');
      
      // 检查是否在 Electron 环境
      let ipcRenderer: any;
      try {
        const electron = typeof window !== 'undefined' ? window.require('electron') : null;
        if (!electron) {
          console.log('[EdgeTTS Service] 非 Electron 环境');
          this.initialized = true;
          return;
        }
        ipcRenderer = electron.ipcRenderer;
      } catch (e: any) {
        console.log('[EdgeTTS Service] 无法获取 electron:', e?.message);
        this.initialized = true;
        return;
      }

      // 调用主进程获取语音列表
      console.log('[EdgeTTS Service] 正在获取语音列表...');
      const voices = await ipcRenderer.invoke('list-edge-tts-voices');

      if (Array.isArray(voices) && voices.length > 0) {
        this.voices = voices;
        this.available = true;
        console.log('[EdgeTTS Service] 初始化成功，语音数量:', voices.length);

        // 提取语言列表
        this._buildLanguageList();
      } else {
        console.warn('[EdgeTTS Service] 返回空语音列表');
      }
    } catch (error: any) {
      console.error('[EdgeTTS Service] 初始化失败:', error?.message);
    } finally {
      this.initialized = true;
      console.log('[EdgeTTS Service] 初始化完成');
    }
  }

  // 构建语言列表
  private _buildLanguageList(): void {
    const langSet = new Set<string>();
    this.voices.forEach(voice => {
      const locale = voice.locale || voice.lang || '';
      if (locale.startsWith('zh-')) {
        langSet.add('zh');
      } else if (locale === 'en-US' || locale === 'en-GB') {
        langSet.add(locale === 'en-US' ? 'en-US' : 'en-GB');
      }
    });
    this.languages = Array.from(langSet);
    console.log('[EdgeTTS Service] 语言列表:', this.languages);
  }

  // 获取语音列表（带过滤）
  getVoices(locale: string = 'zh'): any[] {
    if (!this.available) return [];
    
    return this.voices.filter(voice => {
      const voiceLocale = voice.locale || voice.lang || '';
      if (locale === 'zh') {
        return voiceLocale.startsWith('zh-');
      } else if (locale === 'en-US') {
        return voiceLocale === 'en-US';
      } else if (locale === 'en-GB') {
        return voiceLocale === 'en-GB';
      }
      return false;
    });
  }

  // 获取所有语音
  getAllVoices(): any[] {
    return this.voices;
  }

  // 获取语言列表
  getLanguages(): string[] {
    return this.languages;
  }

  // 检查服务是否可用
  isAvailable(): boolean {
    return this.available;
  }

  // 检查是否已初始化
  isInitialized(): boolean {
    return this.initialized;
  }
}

export default new EdgeTTSService();
