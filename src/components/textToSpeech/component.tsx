import React from "react";
import { isElectron } from "react-device-detect";
import toast from "react-hot-toast";
import { Trans } from "react-i18next";
import { speedList } from "../../constants/dropdownList";
import {
  ConfigService,
  HighlightUtil,
  KookitConfig,
} from "../../assets/lib/kookit-extra-browser.min";
import {
  checkReachPageEnd,
  getAllVoices,
  getFormatFromAudioPath,
  langToName,
  sleep,
  splitSentences,
} from "../../utils/common";
import TTSUtil from "../../utils/reader/ttsUtil";
import { getSplitSentence } from "../../utils/request/reader";
import { Howl } from "howler";
import { fetchUserInfo } from "../../utils/request/user";
import { TextToSpeechProps, TextToSpeechState } from "./interface";
import "./textToSpeech.css";
import kerojiangTTSService from "../../utils/common/kerojiangTTSService";
declare var window: any;
class TextToSpeech extends React.Component<
  TextToSpeechProps,
  TextToSpeechState
> {
  nodeList: {
    text: string;
    voiceName: string;
    voiceEngine: string;
  }[];
  customVoices: any;
  voices: any;
  nativeVoices: any;
  previewPlayer: Howl | null;
  highlightUtil: any;
  navigationDebounceTimer: any; // 用于防抖导航点击
  pendingNavigationIndex: number | null = null; // 存储待处理的导航索引
  constructor(props: TextToSpeechProps) {
    super(props);
    this.highlightUtil = new HighlightUtil(ConfigService);
    this.state = {
      isSupported: false,
      isAudioOn: false,
      isPaused: false,
      currentIndex: 0,
      languageList: [],
      voiceList: {},
      voiceLocale:
        ConfigService.getReaderConfig("voiceLocale") || navigator.language,
      isKerojiangTtsAvailable: false,
      multiRoleEnabled: ConfigService.getAllListConfig(
        "multiRoleVoiceBooks"
      ).includes(props.currentBook?.key),
      multiRoleVoiceType:
        ConfigService.getReaderConfig("multiRoleVoiceType") || "system",
      multiRoleNarratorVoice:
        ConfigService.getReaderConfig("multiRoleNarratorVoice") ||
        ConfigService.getReaderConfig("voiceName"),
      multiRoleMaleVoice:
        ConfigService.getReaderConfig("multiRoleMaleVoice") ||
        ConfigService.getReaderConfig("voiceName"),
      multiRoleFemaleVoice:
        ConfigService.getReaderConfig("multiRoleFemaleVoice") ||
        ConfigService.getReaderConfig("voiceName"),
      multiRoleNarratorEngine:
        ConfigService.getReaderConfig("multiRoleNarratorEngine") ||
        ConfigService.getReaderConfig("voiceEngine"),
      multiRoleMaleEngine:
        ConfigService.getReaderConfig("multiRoleMaleEngine") ||
        ConfigService.getReaderConfig("voiceEngine"),
      multiRoleFemaleEngine:
        ConfigService.getReaderConfig("multiRoleFemaleEngine") ||
        ConfigService.getReaderConfig("voiceEngine"),
      multiRoleChildVoice:
        ConfigService.getReaderConfig("multiRoleChildVoice") ||
        ConfigService.getReaderConfig("voiceName"),
      multiRoleChildEngine:
        ConfigService.getReaderConfig("multiRoleChildEngine") ||
        ConfigService.getReaderConfig("voiceEngine"),
    };
    this.nodeList = [];
    this.voices = [];
    this.customVoices = [];
    this.nativeVoices = [];
    this.previewPlayer = null;
  }
  async componentDidMount() {
    if ("speechSynthesis" in window) {
      this.setState({ isSupported: true });
    }
    window.speechSynthesis && window.speechSynthesis.cancel();
    this.setState({ isAudioOn: false });
    this.nodeList = [];

    // 书打开时清除该书的缓存
    const bookName = this.props.currentBook?.name;
    if (bookName) {
      console.log('[TextToSpeech] 书打开，清除该书缓存:', bookName);
      await TTSUtil.clearKerojiangTtsAudio(bookName);
    }

    const setSpeech = () => {
      return new Promise((resolve) => {
        let synth = window.speechSynthesis;
        let id;
        let timeoutId;

        if (synth) {
          timeoutId = setTimeout(() => {
            clearInterval(id);
            console.log("System voices loading timeout, using empty array");
            resolve([]);
          }, 3000);

          id = setInterval(() => {
            if (synth.getVoices().length !== 0) {
              let voices = synth.getVoices();
              clearTimeout(timeoutId);
              clearInterval(id);
              resolve(
                voices.map((item) => {
                  item.displayName = item.name;
                  item.locale = item.lang;
                  item.plugin = "system";
                  return item;
                })
              );
            }
          }, 10);
        } else {
          resolve([]);
        }
      });
    };
    this.nativeVoices = await setSpeech();
    console.log("Native voices loaded:", this.nativeVoices.length);

    if (isElectron) {
      this.customVoices = TTSUtil.getVoiceList(this.props.plugins);
      console.log("Custom voices loaded:", this.customVoices.length);
      this.voices = [...this.nativeVoices, ...this.customVoices];
    } else {
      this.customVoices = getAllVoices(
        this.props.plugins.filter(
          (item) => item.key === "official-ai-voice-plugin"
        )
      );
      this.voices = [...this.nativeVoices, ...this.customVoices];
    }

    console.log("Total voices available before Edge TTS:", this.voices.length);

    // 先处理一次语音列表（系统语音和自定义语音）
    this.handleVoiceLocaleList();

    // 设置默认语音为中文和 Xiaoxiao
    let voiceName = ConfigService.getReaderConfig("voiceName");
    let voiceEngine = ConfigService.getReaderConfig("voiceEngine");

    if (!voiceName || !voiceEngine) {
      ConfigService.setReaderConfig("voiceName", "zh-CN-XiaoxiaoNeural");
      ConfigService.setReaderConfig("voiceEngine", "kerojiang-tts");
      ConfigService.setReaderConfig("voiceLocale", "zh");
      voiceName = "zh-CN-XiaoxiaoNeural";
      voiceEngine = "kerojiang-tts";
      console.log('[TextToSpeech] 设置默认语音为中文 Xiaoxiao Kerojiang TTS');
    }

    // 检查Kerojiang TTS API可用性
    this.checkKerojiangTtsAvailability();
  }

  checkKerojiangTtsAvailability = async () => {
    console.log('[TextToSpeech] 检查 Kerojiang TTS 服务状态...');
    
    // 等待服务初始化完成
    if (!kerojiangTTSService.isInitialized()) {
      console.log('[TextToSpeech] 等待 Kerojiang TTS 服务初始化...');
      await kerojiangTTSService.init();
    }

    const isAvailable = kerojiangTTSService.isAvailable();
    console.log('[TextToSpeech] Kerojiang TTS 服务状态:', isAvailable ? '可用' : '不可用');

    if (isAvailable) {
      this.setState({ isKerojiangTtsAvailable: true });
      
      // 将 Kerojiang TTS 语音添加到 this.voices 数组
      const kerojiangVoices = kerojiangTTSService.getAllVoices();
      console.log('[TextToSpeech] Kerojiang TTS 语音数量:', kerojiangVoices.length);
      
      // 先过滤掉已存在的 kerojiang-tts 语音（避免重复添加）
      this.voices = this.voices.filter(v => v.plugin !== 'kerojiang-tts');
      this.voices = [...this.voices, ...kerojiangVoices];
      console.log('[TextToSpeech] 总语音数:', this.voices.length);
    } else {
      this.setState({ isKerojiangTtsAvailable: false });
    }

    // 处理语音列表
    this.handleVoiceLocaleList();
  };

  componentWillUnmount() {
    // 清理防抖定时器
    if (this.navigationDebounceTimer) {
      clearTimeout(this.navigationDebounceTimer);
      this.navigationDebounceTimer = null;
    }
    this.pendingNavigationIndex = null;
    
    // 书关闭时清除该书的缓存
    const bookName = this.props.currentBook?.name;
    if (bookName) {
      console.log('[TextToSpeech] 书关闭，清除该书缓存:', bookName);
      TTSUtil.clearKerojiangTtsAudio(bookName);
    }
    
    // 停止预览音频
    this.stopPreviewAudio();
  }

  UNSAFE_componentWillReceiveProps(
    nextProps: Readonly<TextToSpeechProps>,
    nextContext: any
  ): void {
    //plugin更新后重新获取语音列表
    if (nextProps.plugins !== this.props.plugins) {
      this.customVoices = TTSUtil.getVoiceList(nextProps.plugins);

      // 重新构建语音列表，保留Kerojiang TTS语音（如果可用）
      const kerojiangTtsVoices = this.voices.filter(v => v.plugin === 'kerojiang-tts');
      this.voices = [...this.nativeVoices, ...this.customVoices];

      // 重新添加Kerojiang TTS语音
      if (kerojiangTtsVoices.length > 0) {
        this.voices = [...this.voices, ...kerojiangTtsVoices];
      }

      this.handleVoiceLocaleList();
    }
    if (nextProps.currentBook?.key !== this.props.currentBook?.key) {
      // 书籍切换时，清除旧书的缓存
      const oldBookName = this.props.currentBook?.name;
      if (oldBookName) {
        console.log('[TextToSpeech] 书籍切换，清除旧书缓存:', oldBookName);
        TTSUtil.clearKerojiangTtsAudio(oldBookName);
      }
      
      this.setState({
        multiRoleEnabled: ConfigService.getAllListConfig(
          "multiRoleVoiceBooks"
        ).includes(nextProps.currentBook?.key),
      });
    }
  }
  componentDidUpdate(prevProps: Readonly<TextToSpeechProps>) {
    if (this.props.isSpeechAutoStart && !prevProps.isSpeechAutoStart) {
      this.handleSpeechAutoStartRequest();
    }
  }
  clearSpeechStartState = () => {
    if (this.props.speechStartText) {
      this.props.handleSpeechStartText("");
    }
    if (this.props.isSpeechAutoStart) {
      this.props.handleSpeechAutoStart(false);
    }
  };
  normalizeForMatch = (text: string) => {
    return (text || "")
      .replace(/&nbsp;|&ensp;|&emsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  };
  getSpeechStartIndex = (nodeTextList: string[]) => {
    const speechStartText = this.props.speechStartText;

    if (!speechStartText) return -1;

    // 归一化 DOM 选中文本与音频节点文本（HTML 实体、标签、空白差异），
    // 避免精确匹配失败导致无法定位到正确的朗读起始段
    const normalizedStart = this.normalizeForMatch(speechStartText);
    if (!normalizedStart) return -1;

    const normalizedNodes = nodeTextList.map((item) =>
      this.normalizeForMatch(item)
    );

    // 1. 精确包含匹配
    const exactIndex = normalizedNodes.findIndex((item) => {
      return (
        item.includes(normalizedStart) || normalizedStart.includes(item)
      );
    });
    if (exactIndex > -1) return exactIndex;

    // 2. 前缀匹配：取选中文本前 15 个有效字符，定位到包含它的句子段
    const prefix = normalizedStart.substring(0, 15);
    const prefixIndex = normalizedNodes.findIndex((item) =>
      item.includes(prefix)
    );
    if (prefixIndex > -1) return prefixIndex;

    // 3. 相似度匹配：按字符重合度取最高分且超过阈值的句子段
    let bestIndex = -1;
    let bestScore = 0;
    normalizedNodes.forEach((item, index) => {
      if (!item) return;
      const startCharSet = new Set(normalizedStart);
      let commonCount = 0;
      for (const ch of item) {
        if (startCharSet.has(ch)) commonCount++;
      }
      const score = commonCount / Math.max(item.length, 1);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    if (bestScore > 0.5) return bestIndex;

    return -1;
  };
  handleSpeechAutoStartRequest = async () => {
    if (this.state.isAudioOn) {
      await this.handleStop();
    }
    // 每次"从此朗读"都必须清除当前书的旧缓存与内存索引，
    // 否则同一章内不同起点的 part 编号相同，cacheAudio 会因 audioPaths
    // 去重逻辑跳过重新生成，直接播放上一次起点生成的旧音频文件
    TTSUtil.setAudioPaths();
    await TTSUtil.clearKerojiangTtsAudio(this.props.currentBook?.name);
    this.handleStartAudio();
  };
  handleMultiRoleToggle = (enabled: boolean) => {
    if (enabled) {
      if (!this.props.isAuthed) {
        toast(this.props.t("Please upgrade to Pro to use this feature"));
        this.props.handleSetting(true);
        this.props.handleSettingMode("account");
        return;
      }
      ConfigService.setListConfig(
        this.props.currentBook.key,
        "multiRoleVoiceBooks"
      );
    } else {
      ConfigService.deleteListConfig(
        this.props.currentBook.key,
        "multiRoleVoiceBooks"
      );
    }
    this.setState({ multiRoleEnabled: enabled });
  };
  stopPreviewAudio = () => {
    window.speechSynthesis && window.speechSynthesis.cancel();
    if (this.previewPlayer) {
      this.previewPlayer.stop();
      this.previewPlayer.unload();
      this.previewPlayer = null;
    }
  };
  getPreviewText = (voice: any) => {
    const voiceCode =
      voice?.locale ||
      voice?.lang ||
      voice?.language ||
      this.state.voiceLocale ||
      navigator.language ||
      "en";
    const normalizedCode = voiceCode.toLowerCase().split("-")[0];
    const speech =
      KookitConfig.SpeechList.find((item) => item.code === normalizedCode) ||
      KookitConfig.SpeechList[0];
    return speech.example;
  };
  getVoiceByNameAndEngine = (voiceName: string, voiceEngine: string) => {
    return this.voices.find(
      (item: any) => item.name === voiceName && item.plugin === voiceEngine
    );
  };
  handlePreviewVoice = async (voiceName: string, voiceEngine: string) => {
    if (!voiceName) {
      toast(this.props.t("Please select"));
      return;
    }
    const engine = voiceEngine || "system";
    const voice = this.getVoiceByNameAndEngine(voiceName, engine);
    if (!voice) {
      toast.error(this.props.t("Audio loading failed, stopped playback"));
      return;
    }
    const previewText = this.getPreviewText(voice);
    const speed = parseFloat(ConfigService.getReaderConfig("voiceSpeed")) || 1;

    this.stopPreviewAudio();

    if (engine === "system") {
      const msg = new SpeechSynthesisUtterance();
      msg.text = previewText;
      msg.voice =
        this.nativeVoices.find((item: any) => item.name === voiceName) ||
        this.nativeVoices[0];
      msg.rate = speed;
      msg.onerror = () => {
        toast.error(this.props.t("Audio loading failed, stopped playback"));
      };
      window.speechSynthesis && window.speechSynthesis.speak(msg);
      return;
    }

    if (engine === "official-ai-voice-plugin") {
      if (!this.props.isAuthed) {
        toast(this.props.t("Please upgrade to Pro to use this feature"));
        return;
      }
      await fetchUserInfo();
    }

    const plugin = this.props.plugins.find((item) => item.key === engine);
    if (!plugin) {
      toast.error(this.props.t("Audio loading failed, stopped playback"));
      return;
    }
    const pluginVoice = (plugin.voiceList as any[]).find(
      (item) => item.name === voiceName
    );
    if (!pluginVoice) {
      toast.error(this.props.t("Audio loading failed, stopped playback"));
      return;
    }
    const audioPath = await TTSUtil.getAudioPath(
      previewText,
      speed * 100 - 100,
      engine,
      plugin,
      pluginVoice,
      true
    );
    if (!audioPath) {
      toast.error(this.props.t("Audio loading failed, stopped playback"));
      return;
    }
    this.previewPlayer = new Howl({
      src: [audioPath],
      format: [getFormatFromAudioPath(audioPath)],
      onloaderror: () => {
        toast.error(this.props.t("Audio loading failed, stopped playback"));
      },
    });
    this.previewPlayer.play();
  };
  renderVoicePreviewLabel = (
    label: string,
    voiceName: string,
    voiceEngine: string
  ) => {
    return (
      <span className="tts-preview-label">
        <Trans>{label}</Trans>
        <span
          className="tts-preview-btn"
          title={this.props.t("Test")}
          onClick={() => this.handlePreviewVoice(voiceName, voiceEngine)}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M3 10v4h3l4 4V6L6 10H3zm11.5 2a3.5 3.5 0 0 0-2-3.15v6.29A3.5 3.5 0 0 0 14.5 12zm0-7.5v2.06A7.003 7.003 0 0 1 19 12a7.003 7.003 0 0 1-4.5 5.44v2.06c3.45-.9 6-4.03 6-7.5s-2.55-6.6-6-7.5z" />
          </svg>
        </span>
      </span>
    );
  };


  getVoicesByType = (voiceType: string) => {
    const locale = this.state.voiceLocale;
    const voiceList = this.state.voiceList[locale] || this.voices;

    if (voiceType === "system") {
      return voiceList.filter((item: any) => item.plugin === "system");
    } else if (voiceType === "official-ai-voice-plugin") {
      return voiceList.filter(
        (item: any) => item.plugin === "official-ai-voice-plugin"
      );
    } else if (voiceType === "custom") {
      return voiceList.filter(
        (item: any) =>
          item.plugin &&
          item.plugin !== "system" &&
          item.plugin !== "official-ai-voice-plugin"
      );
    }
    return voiceList;
  };
  handleStartAudio = async () => {
    if (
      this.props.isAuthed &&
      ConfigService.getReaderConfig("voiceEngine") !== "system"
    ) {
      toast.loading(this.props.t("Loading audio, please wait..."), {
        id: "tts-load",
      });
      await fetchUserInfo();
    }
    if (
      ConfigService.getReaderConfig("voiceEngine") ===
        "official-ai-voice-plugin" &&
      !this.props.isAuthed
    ) {
      ConfigService.setReaderConfig("voiceEngine", "system");
    }
    this.handleStartSpeech();
  };
  handlePauseAudio = async () => {
    if (window.speechSynthesis) {
      if (window.speechSynthesis.speaking) {
        // 在句子中途暂停，保留 utterance 状态以便从暂停位置恢复
        window.speechSynthesis.pause();
      } else {
        window.speechSynthesis.cancel();
      }
    }
    await TTSUtil.pauseAudio();
    // 暂停播放不清除缓存，保留已生成的音频文件
    this.setState({ isPaused: true });
  };
  handleStop = async () => {
    window.speechSynthesis && window.speechSynthesis.cancel();
    await TTSUtil.stopAudio();
    // 停止播放时清理当前书本的缓存
    const bookName = this.props.currentBook?.name;
    await TTSUtil.clearKerojiangTtsAudio(bookName);
    this.setState({ isAudioOn: false, isPaused: false, currentIndex: 0 });
    this.nodeList = [];
  };
  handlePauseResume = () => {
    const currentNode = this.nodeList[this.state.currentIndex];
    if (!currentNode) return;

    this.setState({ isPaused: false }, () => {
      if (currentNode.voiceEngine !== "system") {
        // 尝试从自定义音频暂停位置恢复，失败则从句首重新播放
        const resumed = TTSUtil.resumeAudio();
        if (!resumed) {
          this.handleCustomRead(this.state.currentIndex);
        }
      } else {
        // 若 Web Speech API 处于暂停状态则从暂停位置恢复，否则从句首重新朗读
        if (window.speechSynthesis && window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        } else {
          this.handleSystemRead(this.state.currentIndex);
        }
      }
    });
  };
  handlePrevSentence = async () => {
    if (!this.state.isAudioOn || this.nodeList.length === 0) return;
    let prevIndex = Math.max(0, this.state.currentIndex - 1);

    // 清除之前的定时器
    if (this.navigationDebounceTimer) {
      clearTimeout(this.navigationDebounceTimer);
    }

    // 更新待处理的索引
    this.pendingNavigationIndex = prevIndex;

    // 设置500ms防抖定时器 - 只响应最后一次点击
    this.navigationDebounceTimer = setTimeout(() => {
      const targetIndex = this.pendingNavigationIndex;
      if (targetIndex === null) return;

      // 取消当前正在播放的音频
      window.speechSynthesis && window.speechSynthesis.cancel();
      // 暂停并清理正在生成的音频
      TTSUtil.stopAudio();
      TTSUtil.pausedMidSentence = false; // 跳转句子时不从暂停位置恢复
      
      this.setState({ currentIndex: targetIndex, isPaused: false }, () => {
        if (this.nodeList[targetIndex]?.voiceEngine !== "system") {
          this.handleCustomRead(targetIndex);
        } else {
          this.handleSystemRead(targetIndex);
        }
      });

      this.navigationDebounceTimer = null;
      this.pendingNavigationIndex = null;
    }, 500);
  };
  handleNextSentence = async () => {
    if (!this.state.isAudioOn || this.nodeList.length === 0) return;
    let nextIndex = this.state.currentIndex + 1;

    // 清除之前的定时器
    if (this.navigationDebounceTimer) {
      clearTimeout(this.navigationDebounceTimer);
    }

    // 更新待处理的索引
    this.pendingNavigationIndex = nextIndex;

    // 设置500ms防抖定时器 - 只响应最后一次点击
    this.navigationDebounceTimer = setTimeout(async () => {
      const targetIndex = this.pendingNavigationIndex;
      if (targetIndex === null) return;

      // 取消当前正在播放的音频
      window.speechSynthesis && window.speechSynthesis.cancel();
      // 暂停并清理正在生成的音频
      TTSUtil.stopAudio();
      TTSUtil.pausedMidSentence = false; // 跳转句子时不从暂停位置恢复

      if (targetIndex >= this.nodeList.length) {
        // Move to next page
        this.setState({ currentIndex: 0, isPaused: false }, async () => {
          this.nodeList = [];
          await this.handleAudio();
        });
      } else {
        this.setState({ currentIndex: targetIndex, isPaused: false }, () => {
          if (this.nodeList[targetIndex]?.voiceEngine !== "system") {
            this.handleCustomRead(targetIndex);
          } else {
            this.handleSystemRead(targetIndex);
          }
        });
      }

      this.navigationDebounceTimer = null;
      this.pendingNavigationIndex = null;
    }, 500);
  };
  handleVoiceSwitch = async (
    newVoiceName: string,
    newVoiceEngine: string,
    previousEngine: string
  ) => {
    if (!this.state.isAudioOn || this.nodeList.length === 0) return;

    const currentIndex = this.state.currentIndex;

    // 鉴权检查（AI 语音）
    if (newVoiceEngine === "official-ai-voice-plugin" && !this.props.isAuthed) {
      toast(this.props.t("Please upgrade to Pro to use this feature"));
      return;
    }

    // 停止系统语音
    window.speechSynthesis && window.speechSynthesis.cancel();

    // 停止自定义音频播放器
    const player = TTSUtil.getPlayer();
    if (player && player.stop) {
      player.stop();
    }
    TTSUtil.isPaused = true;
    TTSUtil.pausedMidSentence = false;

    // 若之前是 AI 语音，清除已生成的音频文件
    if (previousEngine === "official-ai-voice-plugin") {
      await TTSUtil.clearAudioPaths();
    }
    // 重置内存中的音频路径缓存（适用于所有引擎切换）
    TTSUtil.setAudioPaths();

    // AI 语音需要刷新用户信息
    if (this.props.isAuthed && newVoiceEngine !== "system") {
      toast.loading(this.props.t("Loading audio, please wait..."), {
        id: "tts-load",
      });
      await fetchUserInfo();
    }

    // 非多角色模式下，将 nodeList 所有节点更新为新语音
    if (!this.state.multiRoleEnabled) {
      this.nodeList = this.nodeList.map((node) => ({
        ...node,
        voiceName: newVoiceName,
        voiceEngine: newVoiceEngine,
      }));
    }

    // 先将 isPaused 置 true 终止旧循环，再置 false 从当前句子重新播放
    this.setState({ isPaused: true }, () => {
      this.setState({ isPaused: false }, () => {
        if (newVoiceEngine !== "system") {
          this.handleCustomRead(currentIndex);
        } else {
          this.handleSystemRead(currentIndex);
        }
      });
    });
  };
  handleStartSpeech = () => {
    // 设置当前书籍信息用于 Edge TTS 文件命名
    const bookName = this.props.currentBook?.name;
    
    // 获取当前章节索引
    let chapterIndex = 0;
    try {
      if (this.props.htmlBook && this.props.htmlBook.rendition) {
        const position = this.props.htmlBook.rendition.getPosition();
        chapterIndex = parseInt(position.chapterDocIndex) || 0;
      }
    } catch (error) {
      console.warn('[TextToSpeech] Failed to get chapter index:', error);
    }
    
    console.log('[TextToSpeech.handleStartSpeech] 设置书籍信息:', { bookName, chapterIndex });
    TTSUtil.setCurrentBookInfo(bookName, chapterIndex);

    this.setState({ isAudioOn: true, isPaused: false, currentIndex: 0 }, () => {
      this.handleAudio();
    });
  };
  handleAudio = async () => {
    this.nodeList = await this.handleGetText();
    if (this.nodeList.length === 0) {
      return;
    }
    if (this.nodeList[0].voiceEngine !== "system") {
      toast.loading(this.props.t("Loading audio, please wait..."), {
        id: "tts-load",
      });

      await this.handleCustomRead(0);
    } else {
      await this.handleSystemRead(0);
    }
  };
  handleGetText = async () => {
    if ((ConfigService.getReaderConfig("animation") || "none") !== "none") {
      await sleep(1000);
    }
    let nodeList = [];
    let nodeTextList = (await this.props.htmlBook.rendition.audioText()).filter(
      (item: string) => item && item.trim()
    );
    let rawNodeList: string[][] = [];
    if (
      this.props.currentBook.format === "PDF" &&
      !ConfigService.getAllListConfig("convertPDFBooks").includes(
        this.props.currentBook.key
      )
    ) {
    } else {
      rawNodeList = nodeTextList.map((text) => {
        return splitSentences(text);
      });

      // Filter out empty or whitespace-only strings
      nodeTextList = rawNodeList.flat().filter((t) => t && t.trim());
    }
    const speechStartIndex = this.getSpeechStartIndex(nodeTextList);
    if (speechStartIndex > -1) {
      nodeTextList = nodeTextList.slice(speechStartIndex);
    }
    this.clearSpeechStartState();
    if (!this.state.multiRoleEnabled || !this.props.isAuthed) {
      nodeList = nodeTextList.map((text: string) => {
        return {
          text,
          voiceName: ConfigService.getReaderConfig("voiceName"),
          voiceEngine: ConfigService.getReaderConfig("voiceEngine"),
        };
      });
    } else {
      toast.loading(this.props.t("Analyzing roles, please wait..."), {
        id: "tts-load",
      });
      if (nodeTextList.join("").length > 50000) {
        toast.error(this.props.t("The text is too long to analyze"), {
          id: "tts-load",
        });
        this.setState({ isAudioOn: false });
        return [];
      }
      let splitTextList = rawNodeList.flatMap((texts, index) =>
        texts.map((text) => ({ text, index: index }))
      );
      let res = await getSplitSentence(splitTextList);
      toast.dismiss("tts-load");

      let narratorVoice = this.state.multiRoleNarratorVoice;
      let narratorEngine = this.state.multiRoleNarratorEngine;
      let maleVoice = this.state.multiRoleMaleVoice;
      let maleEngine = this.state.multiRoleMaleEngine;
      let femaleVoice = this.state.multiRoleFemaleVoice;
      let femaleEngine = this.state.multiRoleFemaleEngine;
      let childVoice = this.state.multiRoleChildVoice;
      let childEngine = this.state.multiRoleChildEngine;
      if (res && res.data && res.data.sentences) {
        nodeList = res.data.sentences.map((item: any) => {
          let voiceName = narratorVoice;
          let voiceEngine = narratorEngine;
          if (item.role === "male") {
            voiceName = maleVoice || narratorVoice;
            voiceEngine = maleEngine || narratorEngine;
          } else if (item.role === "female") {
            voiceName = femaleVoice || narratorVoice;
            voiceEngine = femaleEngine || narratorEngine;
          } else if (item.role === "child") {
            voiceName = childVoice || narratorVoice;
            voiceEngine = childEngine || narratorEngine;
          }
          return {
            text: item.text,
            voiceName,
            voiceEngine,
          };
        });
      } else {
        toast.error(this.props.t("Analysis failed"));
        this.setState({ isAudioOn: false });
        return [];
      }
    }

    if (nodeList.length === 0) {
      if (
        this.props.currentBook.format === "PDF" &&
        !ConfigService.getAllListConfig("convertPDFBooks").includes(
          this.props.currentBook.key
        )
      ) {
        let currentPosition = this.props.htmlBook.rendition.getPosition();
        await this.props.htmlBook.rendition.goToChapterIndex(
          parseInt(currentPosition.chapterDocIndex) +
            (this.props.readerMode === "double" ? 2 : 1)
        );
      } else {
        await this.props.htmlBook.rendition.next();
      }

      nodeList = await this.handleGetText();
    }
    return nodeList;
  };
  async handleCustomRead(nodeIndex: number) {
    let speed = parseFloat(ConfigService.getReaderConfig("voiceSpeed")) || 1;
    if (!this.state.isAudioOn) {
      TTSUtil.setAudioPaths();
      // 开始播放前清除当前书的缓存
      await TTSUtil.clearKerojiangTtsAudio(this.props.currentBook?.name);
    }

    for (let index = nodeIndex; index < this.nodeList.length; index++) {
      if (this.state.isPaused || !this.state.isAudioOn) return;
      this.setState({ currentIndex: index });
      let node = this.nodeList[index];
      let style = this.highlightUtil.buildTtsHighlightStyle(
        this.props.currentBook.format === "PDF" &&
          !ConfigService.getAllListConfig("convertPDFBooks").includes(
            this.props.currentBook.key
          ),
        ConfigService.getReaderConfig("textOrientation") === "vertical"
      );
      this.props.htmlBook.rendition.highlightAudioNode(node.text, style);

      // 获取当前页码
      let pageIndex = 0;
      try {
        const position = this.props.htmlBook.rendition.getPosition();
        pageIndex = parseInt(position.chapterDocIndex) || 0;
      } catch (error) {
        console.error("Failed to get page index:", error);
      }

      if (index === nodeIndex) {
        let result = await TTSUtil.cacheAudio(
          index,
          speed * 100 - 100,
          this.props.plugins,
          this.nodeList,
          10,
          true,
          node.voiceEngine === "official-ai-voice-plugin",
          pageIndex,
          undefined, // part参数
          true // isCriticalPart: 当前朗读的部分是重要的
        );
        console.log("cacheAudio result:", result);
        toast.dismiss("tts-load");
        if (result === "error") {
          // 只有配置错误才显示错误
          toast.error(this.props.t("Audio loading failed, stopped playback"));
          this.setState({ isAudioOn: false });
          this.nodeList = [];
          return;
        }
        // 如果result是undefined或空，表示语音生成失败但可以继续
        // 不显示错误，继续处理下一个部分
      }
      if (this.nodeList[index].voiceEngine === "system") {
        await this.handleSystemRead(index);
        break;
      }

      TTSUtil.cacheAudio(
        index + 1,
        speed * 100 - 100,
        this.props.plugins,
        this.nodeList,
        20,
        false,
        node.voiceEngine === "official-ai-voice-plugin",
        pageIndex,
        undefined, // part参数
        false // isCriticalPart: 预缓存的部分不是重要的
      );
      let res = await this.handleSpeech(index);
      if (res === "error") {
        toast.error(this.props.t("Audio loading failed, stopped playback"));
        this.setState({ isAudioOn: false });
        this.nodeList = [];
        return;
      }
      if (this.state.isPaused || !this.state.isAudioOn) return;
      let visibleTextList = await this.props.htmlBook.rendition.visibleText();
      let lastVisibleTextList = visibleTextList;
      if (
        this.props.currentBook.format === "PDF" &&
        !ConfigService.getAllListConfig("convertPDFBooks").includes(
          this.props.currentBook.key
        )
      ) {
      } else {
        let rawNodeList = visibleTextList.map((text) => {
          return splitSentences(text);
        });

        lastVisibleTextList = rawNodeList.flat();
      }
      let isReachPageEnd = checkReachPageEnd(
        index,
        this.nodeList,
        lastVisibleTextList,
        this.props.currentBook
      );
      if (index === this.nodeList.length - 1) {
        isReachPageEnd = true;
      }

      if (isReachPageEnd) {
        if (
          this.props.currentBook.format === "PDF" &&
          !ConfigService.getAllListConfig("convertPDFBooks").includes(
            this.props.currentBook.key
          )
        ) {
          let currentPosition = this.props.htmlBook.rendition.getPosition();
          await this.props.htmlBook.rendition.goToChapterIndex(
            parseInt(currentPosition.chapterDocIndex) +
              (this.props.readerMode === "double" ? 2 : 1)
          );
        } else {
          if (index === this.nodeList.length - 1) {
            await this.props.htmlBook.rendition.nextChapter();
          } else {
            await this.props.htmlBook.rendition.next();
          }
        }
      }
      if (res === "end") {
        break;
      }
    }
    // 当前页的所有部分播放完成，清除当前书的缓存
    if (this.nodeList[this.state.currentIndex]?.voiceEngine === "kerojiang-tts") {
      await TTSUtil.clearKerojiangTtsAudio(this.props.currentBook?.name);
    }

    if (this.state.isAudioOn && this.props.isReading) {
      await TTSUtil.clearAudioPaths();
      TTSUtil.setAudioPaths();
      let position = this.props.htmlBook.rendition.getPosition();
      ConfigService.setObjectConfig(
        this.props.currentBook.key,
        position,
        "recordLocation"
      );
      // 修复：自动翻章后更新当前书籍/章节信息，
      // 防止后续章节音频文件名与上一章冲突（ch/part 重名导致播放旧音频）
      const newChapterIndex = parseInt(position.chapterDocIndex) || 0;
      TTSUtil.setCurrentBookInfo(
        this.props.currentBook?.name,
        newChapterIndex
      );
      // 修复：翻章后清理旧章节的音频缓存文件，避免残留文件被误播放
      await TTSUtil.clearKerojiangTtsAudio(this.props.currentBook?.name);
      this.nodeList = [];
      await this.handleAudio();
    }
  }
  async handleSystemRead(index) {
    if (this.state.isPaused || !this.state.isAudioOn) return;
    if (index >= this.nodeList.length) {
      this.nodeList = [];
      await this.handleAudio();
      return;
    }
    this.setState({ currentIndex: index });
    let node = this.nodeList[index];
    let style = this.highlightUtil.buildTtsHighlightStyle(
      this.props.currentBook.format === "PDF" &&
        !ConfigService.getAllListConfig("convertPDFBooks").includes(
          this.props.currentBook.key
        ),
      ConfigService.getReaderConfig("textOrientation") === "vertical"
    );
    this.props.htmlBook.rendition.highlightAudioNode(node.text, style);
    toast.dismiss("tts-load");
    let res = await this.handleSystemSpeech(
      index,
      node.voiceName || ConfigService.getReaderConfig("voiceName"),
      parseFloat(ConfigService.getReaderConfig("voiceSpeed")) || 1
    );

    if (res === "start") {
      let visibleTextList = await this.props.htmlBook.rendition.visibleText();

      let lastVisibleTextList = visibleTextList;
      if (
        this.props.currentBook.format === "PDF" &&
        !ConfigService.getAllListConfig("convertPDFBooks").includes(
          this.props.currentBook.key
        )
      ) {
      } else {
        let rawNodeList = visibleTextList.map((text) => {
          return splitSentences(text);
        });

        lastVisibleTextList = rawNodeList.flat();
      }

      let isReachPageEnd = checkReachPageEnd(
        index,
        this.nodeList,
        lastVisibleTextList,
        this.props.currentBook
      );
      if (index === this.nodeList.length - 1) {
        isReachPageEnd = true;
      }
      if (isReachPageEnd) {
        if (
          this.props.currentBook.format === "PDF" &&
          !ConfigService.getAllListConfig("convertPDFBooks").includes(
            this.props.currentBook.key
          )
        ) {
          let currentPosition = this.props.htmlBook.rendition.getPosition();
          await this.props.htmlBook.rendition.goToChapterIndex(
            parseInt(currentPosition.chapterDocIndex) +
              (this.props.readerMode === "double" ? 2 : 1)
          );
        } else {
          if (index === this.nodeList.length - 1) {
            await this.props.htmlBook.rendition.nextChapter();
          } else {
            await this.props.htmlBook.rendition.next();
          }
        }
      }
      if (
        this.state.isAudioOn &&
        this.props.isReading &&
        index === this.nodeList.length
      ) {
        let position = this.props.htmlBook.rendition.getPosition();
        ConfigService.setObjectConfig(
          this.props.currentBook.key,
          position,
          "recordLocation"
        );
        this.nodeList = [];
        await this.handleAudio();
        return;
      }
      index++;
      if (
        this.nodeList[index] &&
        this.nodeList[index].voiceEngine !== "system"
      ) {
        await this.handleCustomRead(index);
      } else {
        await this.handleSystemRead(index);
      }
    } else if (res === "end") {
      return;
    }
  }
  handleSpeech = async (index: number) => {
    return new Promise<string>(async (resolve) => {
      let res = await TTSUtil.readAloud(index);
      if (res === "loaderror") {
        resolve("error");
      } else if (res === "skip") {
        // 跳过这个部分，继续下一个
        console.log(`Skipping part ${index}, continuing to next`);
        resolve("start");
      } else {
        let player = TTSUtil.getPlayer();
        player.on("end", async () => {
          // 不再在每个音频播放完成后清除缓存
          // 只在停止播放或全部播放完时清除

          if (!(this.state.isAudioOn && this.props.isReading)) {
            resolve("end");
          }
          resolve("start");
        });
      }
    });
  };
  handleSystemSpeech = async (
    index: number,
    voiceName: string,
    speed: number
  ) => {
    return new Promise<string>(async (resolve) => {
      var msg = new SpeechSynthesisUtterance();
      msg.text = this.nodeList[index].text
        .replace(/\s\s/g, "")
        .replace(/\r/g, "")
        .replace(/\n/g, "")
        .replace(/\t/g, "")
        .replace(/&/g, "")
        .replace(/\f/g, "");
      if (!voiceName) {
        voiceName = this.nativeVoices[0]?.name;
      }
      msg.voice = this.nativeVoices.find(
        (voice: any) => voice.name === voiceName
      );
      msg.rate = speed;
      window.speechSynthesis && window.speechSynthesis.cancel();
      window.speechSynthesis.speak(msg);
      msg.onerror = (err) => {
        console.error(err);
        resolve("end");
      };

      msg.onend = async () => {
        if (!(this.state.isAudioOn && this.props.isReading)) {
          resolve("end");
        }
        resolve("start");
      };
    });
  };
  handleVoiceLocaleList = () => {
    let voiceList = {};
    let totalVoiceList = this.voices;

    console.log('[TextToSpeech] Processing voice list, total voices:', totalVoiceList.length);

    // 按大类分组：中文和英文
    totalVoiceList.forEach((voice) => {
      const locale = voice.locale || voice.Locale || voice.lang || '';
      let mainLang = '';

      if (locale.startsWith('zh-')) {
        mainLang = 'zh'; // 中文大类
      } else if (locale === 'en-US' || locale === 'en-GB') {
        mainLang = 'en'; // 英文大类（只包含美英）
      } else {
        // 如果没有匹配的语言，跳过此语音
        return;
      }

      if (!voiceList[mainLang]) {
        voiceList[mainLang] = [];
      }
      voiceList[mainLang].push(voice);
    });

    // 语言列表只显示中文和英文
    let languageList: string[] = [];
    if (voiceList['zh'] && voiceList['zh'].length > 0) languageList.push('zh');
    if (voiceList['en'] && voiceList['en'].length > 0) languageList.push('en');

    // 如果没有找到合适的语言，但有语音可用，至少显示一个默认语言选项
    if (languageList.length === 0 && this.voices.length > 0) {
      // 检查是否有任何中文语音（包括系统语音）
      const hasChineseVoices = this.voices.some(voice =>
        (voice.locale && voice.locale.startsWith('zh-')) ||
        (voice.lang && voice.lang.startsWith('zh-'))
      );
      if (hasChineseVoices) languageList.push('zh');

      // 检查是否有任何英文语音
      const hasEnglishVoices = this.voices.some(voice =>
        voice.locale === 'en-US' || voice.locale === 'en-GB' ||
        voice.lang === 'en-US' || voice.lang === 'en-GB'
      );
      if (hasEnglishVoices) languageList.push('en');

      // 如果还是没有找到，使用默认中文
      if (languageList.length === 0) languageList.push('zh');
    }

    // 默认显示中文
    if (!this.state.voiceLocale || this.state.voiceLocale === 'zh-CN') {
      this.setState({ voiceLocale: 'zh' });
      ConfigService.setReaderConfig("voiceLocale", "zh");
    }

    console.log('[TextToSpeech] Voice list updated:', {
      languageList,
      voiceListKeys: Object.keys(voiceList),
      totalVoices: this.voices.length,
      currentLocale: this.state.voiceLocale,
      availableVoicesForCurrentLocale: voiceList[this.state.voiceLocale]?.length || 0,
      kerojiangTtsVoices: this.voices.filter(v => v.plugin === 'kerojiang-tts').length,
      kerojiangTtsApiAvailable: this.state.isKerojiangTtsAvailable
    });

    this.setState({ languageList, voiceList }, () => {
      console.log('[TextToSpeech] State updated:', {
        languageList: this.state.languageList,
        voiceLocale: this.state.voiceLocale,
        voiceListKeys: Object.keys(this.state.voiceList),
        currentLocaleVoices: this.state.voiceList[this.state.voiceLocale]?.length || 0
      });
    });
  };
  render() {
    return (
      <>
        <div className="tts-player-container">
          <div className="tts-player-controls">
            <span
              className="tts-player-btn"
              title={this.props.t("Stop")}
              onClick={() => this.handleStop()}
              style={
                !this.state.isAudioOn
                  ? { opacity: 0.3, cursor: "not-allowed" }
                  : {}
              }
            >
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="currentColor"
              >
                <path d="M6 6h12v12H6z" />
              </svg>
            </span>
            <span
              className="tts-player-btn"
              title={this.props.t("Previous")}
              onClick={() => this.handlePrevSentence()}
              style={
                !this.state.isAudioOn
                  ? { opacity: 0.3, cursor: "not-allowed" }
                  : {}
              }
            >
              <svg
                viewBox="0 0 24 24"
                width="22"
                height="22"
                fill="currentColor"
              >
                <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
              </svg>
            </span>
            <span
              className="tts-player-btn tts-player-btn-main"
              title={
                !this.state.isAudioOn
                  ? this.props.t("Play")
                  : this.state.isPaused
                    ? this.props.t("Resume")
                    : this.props.t("Pause")
              }
              onClick={() => {
                if (!this.state.isAudioOn && !this.state.isPaused) {
                  this.handleStartAudio();
                } else if (!this.state.isPaused) {
                  this.handlePauseAudio();
                } else {
                  this.handlePauseResume();
                }
              }}
            >
              {!this.state.isAudioOn || this.state.isPaused ? (
                <svg
                  viewBox="0 0 24 24"
                  width="28"
                  height="28"
                  fill="currentColor"
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  width="28"
                  height="28"
                  fill="currentColor"
                >
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              )}
            </span>
            <span
              className="tts-player-btn"
              title={this.props.t("Next")}
              onClick={() => this.handleNextSentence()}
              style={
                !this.state.isAudioOn
                  ? { opacity: 0.3, cursor: "not-allowed" }
                  : {}
              }
            >
              <svg
                viewBox="0 0 24 24"
                width="22"
                height="22"
                fill="currentColor"
              >
                <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
              </svg>
            </span>
            <span
              className="tts-player-btn"
              title={this.props.t("Stop")}
              onClick={() => this.handleStop()}
              style={
                !this.state.isAudioOn
                  ? { opacity: 0.3, cursor: "not-allowed" }
                  : {}
              }
            >
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="currentColor"
              >
                <path d="M6 6h12v12H6z" />
              </svg>
            </span>
          </div>
          {this.state.isAudioOn && this.nodeList.length > 0 && (
            <div className="tts-player-info">
              {this.state.currentIndex + 1} / {this.nodeList.length}
            </div>
          )}
        </div>
        {isElectron && (
          <div
            style={{
              marginTop: "10px",
              marginLeft: "20px",
              marginRight: "20px",
              padding: "8px",
              backgroundColor: this.state.isKerojiangTtsAvailable
                ? "rgba(100, 150, 255, 0.1)"
                : "rgba(255, 150, 100, 0.1)",
              borderRadius: "6px",
              fontSize: "11px",
              lineHeight: "1.4",
            }}
          >
            <div style={{ fontWeight: 500, marginBottom: "3px" }}>
              {this.state.isKerojiangTtsAvailable
                ? "💡 Kerojiang TTS 可用"
                : "⚠️ Kerojiang TTS 不可用"}
            </div>
            <div>
              {this.state.isKerojiangTtsAvailable
                ? "Kerojiang TTS 服务正常，可选择 Kerojiang TTS 语音进行播放"
                : "Kerojiang TTS 服务不可用，请检查网络连接"}
            </div>
          </div>
        )}
        <div
          className="setting-dialog-new-title"
          style={{
            marginLeft: "20px",
            width: "88%",
            marginTop: "20px",
            fontWeight: 500,
          }}
        >
          <Trans>Language</Trans>
          <select
            name=""
            className="lang-setting-dropdown"
            id="text-speech-locale"
            value={ConfigService.getReaderConfig("voiceLocale")}
            onChange={(event) => {
              ConfigService.setReaderConfig("voiceLocale", event.target.value);
              this.setState({ voiceLocale: event.target.value });
            }}
          >
            {this.state.languageList.map((item) => {
              // 自定义显示名称
              let displayName = item;
              if (item === 'zh') displayName = '中文';
              else if (item === 'en') displayName = 'English';

              return (
                <option
                  value={item}
                  key={item}
                  className="lang-setting-option"
                  selected={
                    item === ConfigService.getReaderConfig("voiceLocale")
                  }
                >
                  {langToName(item)}
                </option>
              );
            })}
          </select>
        </div>
        <div
          className="setting-dialog-new-title"
          style={{
            marginLeft: "20px",
            width: "88%",
            fontWeight: 500,
          }}
        >
          {this.renderVoicePreviewLabel(
            "Voice",
            ConfigService.getReaderConfig("voiceName"),
            ConfigService.getReaderConfig("voiceEngine")
          )}
          <select
            name=""
            className="lang-setting-dropdown"
            id="text-speech-voice"
            value={[
              ConfigService.getReaderConfig("voiceName"),
              ConfigService.getReaderConfig("voiceEngine"),
            ].join("#")}
            onChange={(event) => {
              let selectedValue = event.target.value;
              let [voiceName, plugin] = selectedValue.split("#");
              const previousEngine =
                ConfigService.getReaderConfig("voiceEngine");
              ConfigService.setReaderConfig("voiceName", voiceName);
              let voice = this.voices.find(
                (item) => item.name === voiceName && item.plugin === plugin
              );
              if (!voice) {
                return;
              }
              const newEngine = voice.plugin || "system";
              ConfigService.setReaderConfig("voiceEngine", newEngine);
              if (
                voice.plugin === "official-ai-voice-plugin" &&
                event.target.value.indexOf("Neural") > -1
              ) {
                toast(
                  this.props.t(
                    "Due to the high cost of Azure TTS voices, this voice will consume 5 times of your daily quota than normal voice"
                  ),
                  {
                    duration: 8000,
                    id: "costWarning",
                  }
                );
              }
              toast.success(this.props.t("Setup successful"));
              if (this.state.isAudioOn) {
                this.handleVoiceSwitch(voiceName, newEngine, previousEngine);
              }
              this.forceUpdate();
            }}
          >
            {(() => {
              const availableVoices = this.state.voiceList[this.state.voiceLocale] || [];
              console.log('[TextToSpeech] Voice dropdown render:', {
                voiceLocale: this.state.voiceLocale,
                voiceListKeys: Object.keys(this.state.voiceList),
                availableVoicesCount: availableVoices.length,
                totalVoices: this.voices.length,
              });
              if (availableVoices.length === 0) {
                return (
                  <option value="" className="lang-setting-option">
                    {this.props.t("No voices available")}
                  </option>
                );
              }
              return availableVoices.map((item) => {
                  const isKerojiangTts = item.plugin === "kerojiang-tts";
                  return (
                    <option
                      value={[item.name, item.plugin].join("#")}
                      key={[item.name, item.plugin].join("#")}
                      className="lang-setting-option"
                      selected={
                        item.name ===
                          ConfigService.getReaderConfig("voiceName") &&
                        item.plugin ===
                          ConfigService.getReaderConfig("voiceEngine")
                      }
                    >
                      {isKerojiangTts ? "🎙️ " : ""}
                      {this.props.t(item.displayName || item.FriendlyName || item.name)}
                      {isKerojiangTts ? " (Kerojiang)" : ""}
                    </option>
                  );
                }
              );
            })()}
          </select>
        </div>

        <div
          className="setting-dialog-new-title"
          style={{ marginLeft: "20px", width: "88%", fontWeight: 500 }}
        >
          <Trans>Speed</Trans>
          <select
            name=""
            id="text-speech-speed"
            className="lang-setting-dropdown"
            value={ConfigService.getReaderConfig("voiceSpeed") || "1"}
            onChange={(event) => {
              ConfigService.setReaderConfig("voiceSpeed", event.target.value);
              if (this.state.isAudioOn) {
                toast(this.props.t("Take effect in a while"));
              }
              this.forceUpdate();
            }}
          >
            {speedList.option.map((item) => (
              <option
                value={item.value}
                className="lang-setting-option"
                key={item.value}
              >
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ marginTop: "20px", textAlign: "center" }}>
          <span
            style={{
              textDecoration: "underline",
              cursor: "pointer",
              textAlign: "center",
            }}
            onClick={() => {
              this.props.handleSetting(true);
              this.props.handleSettingMode("plugins");
            }}
          >
            <Trans>Add new voice</Trans>
          </span>
        </div>
        {/* Multi-role reading section */}
        <div
          className="setting-dialog-new-title"
          style={{
            marginLeft: "20px",
            width: "88%",
            marginTop: "20px",
            fontWeight: 500,
          }}
        >
          <span style={{ width: "calc(100% - 50px)" }}>
            <Trans>AI multi-role speech</Trans>
          </span>

          <span
            className="single-control-switch"
            onClick={() => {
              this.handleMultiRoleToggle(!this.state.multiRoleEnabled);
            }}
            style={this.state.multiRoleEnabled ? {} : { opacity: 0.6 }}
          >
            <span
              className="single-control-button"
              style={
                this.state.multiRoleEnabled
                  ? {
                      transform: "translateX(20px)",
                      transition: "transform 0.5s ease",
                    }
                  : {
                      transform: "translateX(0px)",
                      transition: "transform 0.5s ease",
                    }
              }
            ></span>
          </span>
        </div>
        <p
          className="setting-option-subtitle"
          style={{ marginLeft: "20px", marginRight: "20px" }}
        >
          <Trans>
            {
              "Use AI to analyze books, with different characters reading aloud in different voices"
            }
          </Trans>
        </p>
        {this.state.multiRoleEnabled && (
          <>
            {/* Voice Type Selection */}
            <div
              className="setting-dialog-new-title"
              style={{ marginLeft: "20px", width: "88%", fontWeight: 500 }}
            >
              <Trans>Voice type</Trans>
              <select
                name=""
                className="lang-setting-dropdown"
                id="multi-role-voice-type"
                value={this.state.multiRoleVoiceType}
                onChange={(event) => {
                  this.setState({ multiRoleVoiceType: event.target.value });
                  ConfigService.setReaderConfig(
                    "multiRoleVoiceType",
                    event.target.value
                  );
                }}
              >
                <option value="" className="lang-setting-option">
                  {this.props.t("Please select")}
                </option>
                <option value="system" className="lang-setting-option">
                  {this.props.t("System voice")}
                </option>
                <option
                  value="kerojiang-tts"
                  className="lang-setting-option"
                  selected={this.state.multiRoleVoiceType === "kerojiang-tts"}
                >
                  {this.props.t("Kerojiang TTS")}
                </option>
                <option
                  value="official-ai-voice-plugin"
                  className="lang-setting-option"
                >
                  {this.props.t("Official AI Voice")}
                </option>
                <option value="custom" className="lang-setting-option">
                  {this.props.t("Custom voice")}
                </option>
              </select>
            </div>
            {/* Narrator voice */}
            <div
              className="setting-dialog-new-title"
              style={{ marginLeft: "20px", width: "88%", fontWeight: 500 }}
            >
              {this.renderVoicePreviewLabel(
                "Narrator voice",
                this.state.multiRoleNarratorVoice,
                this.state.multiRoleNarratorEngine
              )}
              <select
                name=""
                className="lang-setting-dropdown"
                id="multi-role-narrator-voice"
                value={
                  this.state.multiRoleNarratorVoice
                    ? [
                        this.state.multiRoleNarratorVoice,
                        this.state.multiRoleNarratorEngine,
                      ].join("#")
                    : ""
                }
                onChange={(event) => {
                  let selectedValue = event.target.value;
                  let [voiceName, plugin] = selectedValue.split("#");
                  ConfigService.setReaderConfig(
                    "multiRoleNarratorVoice",
                    voiceName
                  );
                  ConfigService.setReaderConfig(
                    "multiRoleNarratorEngine",
                    plugin || "system"
                  );
                  this.setState({
                    multiRoleNarratorVoice: voiceName,
                    multiRoleNarratorEngine: plugin || "system",
                  });
                  toast.success(this.props.t("Setup successful"));
                }}
              >
                <option value="" className="lang-setting-option">
                  {this.props.t("Please select")}
                </option>
                {this.getVoicesByType(this.state.multiRoleVoiceType).map(
                  (item) => (
                    <option
                      value={[item.name, item.plugin].join("#")}
                      key={[item.name, item.plugin].join("#")}
                      className="lang-setting-option"
                    >
                      {item.plugin === "kerojiang-tts" ? "🎙️ " : ""}
                      {this.props.t(item.displayName || item.FriendlyName || item.name)}
                      {item.plugin === "kerojiang-tts" ? " (Kerojiang)" : ""}
                    </option>
                  )
                )}
              </select>
            </div>
            {/* Male voice */}
            <div
              className="setting-dialog-new-title"
              style={{ marginLeft: "20px", width: "88%", fontWeight: 500 }}
            >
              {this.renderVoicePreviewLabel(
                "Male voice",
                this.state.multiRoleMaleVoice,
                this.state.multiRoleMaleEngine
              )}
              <select
                name=""
                className="lang-setting-dropdown"
                id="multi-role-male-voice"
                value={
                  this.state.multiRoleMaleVoice
                    ? [
                        this.state.multiRoleMaleVoice,
                        this.state.multiRoleMaleEngine,
                      ].join("#")
                    : ""
                }
                onChange={(event) => {
                  let selectedValue = event.target.value;
                  let [voiceName, plugin] = selectedValue.split("#");
                  ConfigService.setReaderConfig(
                    "multiRoleMaleVoice",
                    voiceName
                  );
                  ConfigService.setReaderConfig(
                    "multiRoleMaleEngine",
                    plugin || "system"
                  );
                  this.setState({
                    multiRoleMaleVoice: voiceName,
                    multiRoleMaleEngine: plugin || "system",
                  });
                  toast.success(this.props.t("Setup successful"));
                }}
              >
                <option value="" className="lang-setting-option">
                  {this.props.t("Please select")}
                </option>
                {this.getVoicesByType(this.state.multiRoleVoiceType)
                  .filter((item) => !item.gender || item.gender === "male")
                  .map((item) => (
                    <option
                      value={[item.name, item.plugin].join("#")}
                      key={[item.name, item.plugin].join("#")}
                      className="lang-setting-option"
                    >
                      {item.plugin === "kerojiang-tts" ? "🎙️ " : ""}
                      {this.props.t(item.displayName || item.FriendlyName || item.name)}
                      {item.plugin === "kerojiang-tts" ? " (Kerojiang)" : ""}
                    </option>
                  ))}
              </select>
            </div>
            {/* Female voice */}
            <div
              className="setting-dialog-new-title"
              style={{ marginLeft: "20px", width: "88%", fontWeight: 500 }}
            >
              {this.renderVoicePreviewLabel(
                "Female voice",
                this.state.multiRoleFemaleVoice,
                this.state.multiRoleFemaleEngine
              )}
              <select
                name=""
                className="lang-setting-dropdown"
                id="multi-role-female-voice"
                value={
                  this.state.multiRoleFemaleVoice
                    ? [
                        this.state.multiRoleFemaleVoice,
                        this.state.multiRoleFemaleEngine,
                      ].join("#")
                    : ""
                }
                onChange={(event) => {
                  let selectedValue = event.target.value;
                  let [voiceName, plugin] = selectedValue.split("#");
                  ConfigService.setReaderConfig(
                    "multiRoleFemaleVoice",
                    voiceName
                  );
                  ConfigService.setReaderConfig(
                    "multiRoleFemaleEngine",
                    plugin || "system"
                  );
                  this.setState({
                    multiRoleFemaleVoice: voiceName,
                    multiRoleFemaleEngine: plugin || "system",
                  });
                  toast.success(this.props.t("Setup successful"));
                }}
              >
                <option value="" className="lang-setting-option">
                  {this.props.t("Please select")}
                </option>
                {this.getVoicesByType(this.state.multiRoleVoiceType)
                  .filter((item) => !item.gender || item.gender === "female")
                  .map((item) => (
                    <option
                      value={[item.name, item.plugin].join("#")}
                      key={[item.name, item.plugin].join("#")}
                      className="lang-setting-option"
                    >
                      {item.plugin === "kerojiang-tts" ? "🎙️ " : ""}
                      {this.props.t(item.displayName || item.FriendlyName || item.name)}
                      {item.plugin === "kerojiang-tts" ? " (Kerojiang)" : ""}
                    </option>
                  ))}
              </select>
            </div>
            {/* Child voice */}
            <div
              className="setting-dialog-new-title"
              style={{ marginLeft: "20px", width: "88%", fontWeight: 500 }}
            >
              {this.renderVoicePreviewLabel(
                "Child voice",
                this.state.multiRoleChildVoice,
                this.state.multiRoleChildEngine
              )}
              <select
                name=""
                className="lang-setting-dropdown"
                id="multi-role-child-voice"
                value={
                  this.state.multiRoleChildVoice
                    ? [
                        this.state.multiRoleChildVoice,
                        this.state.multiRoleChildEngine,
                      ].join("#")
                    : ""
                }
                onChange={(event) => {
                  let selectedValue = event.target.value;
                  let [voiceName, plugin] = selectedValue.split("#");
                  ConfigService.setReaderConfig(
                    "multiRoleChildVoice",
                    voiceName
                  );
                  ConfigService.setReaderConfig(
                    "multiRoleChildEngine",
                    plugin || "system"
                  );
                  this.setState({
                    multiRoleChildVoice: voiceName,
                    multiRoleChildEngine: plugin || "system",
                  });
                  toast.success(this.props.t("Setup successful"));
                }}
              >
                <option value="" className="lang-setting-option">
                  {this.props.t("Please select")}
                </option>
                {this.getVoicesByType(this.state.multiRoleVoiceType).map(
                  (item) => (
                    <option
                      value={[item.name, item.plugin].join("#")}
                      key={[item.name, item.plugin].join("#")}
                      className="lang-setting-option"
                    >
                      {this.props.t(item.displayName || item.name)}
                    </option>
                  )
                )}
              </select>
            </div>
          </>
        )}
      </>
    );
  }
}

export default TextToSpeech;
