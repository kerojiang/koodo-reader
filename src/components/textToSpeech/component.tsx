import React from "react";
import { isElectron } from "react-device-detect";
import toast from "react-hot-toast";
import { Trans } from "react-i18next";
import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";
import { speedList } from "../../constants/dropdownList";
import {
  getAllVoices,
  langToName,
  sleep,
  splitSentences,
  trimSpecialCharacters,
} from "../../utils/common";
import TTSUtil from "../../utils/reader/ttsUtil";
import { getSplitSentence } from "../../utils/request/reader";
import { fetchUserInfo } from "../../utils/request/user";
import { TextToSpeechProps, TextToSpeechState } from "./interface";
import "./textToSpeech.css";
import edgeTTSService from "../../utils/common/edgeTTSService";
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
  navigationDebounceTimer: any; // 用于防抖导航点击
  pendingNavigationIndex: number | null = null; // 存储待处理的导航索引
  constructor(props: TextToSpeechProps) {
    super(props);
    this.state = {
      isSupported: false,
      isAudioOn: false,
      isPaused: false,
      currentIndex: 0,
      languageList: [],
      voiceList: {},
      voiceLocale:
        ConfigService.getReaderConfig("voiceLocale") || navigator.language,
      isEdgeTtsAvailable: false,
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
    };
    this.nodeList = [];
    this.voices = [];
    this.customVoices = [];
    this.nativeVoices = [];
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
      await TTSUtil.clearEdgeTtsAudio(bookName);
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
      ConfigService.setReaderConfig("voiceEngine", "edge-tts");
      ConfigService.setReaderConfig("voiceLocale", "zh");
      voiceName = "zh-CN-XiaoxiaoNeural";
      voiceEngine = "edge-tts";
      console.log('[TextToSpeech] 设置默认语音为中文 Xiaoxiao Edge TTS');
    }

    // 检查Edge TTS API可用性
    this.checkEdgeTtsAvailability();
  }

  checkEdgeTtsAvailability = async () => {
    console.log('[TextToSpeech] 检查 Edge TTS 服务状态...');
    
    // 等待服务初始化完成
    if (!edgeTTSService.isInitialized()) {
      console.log('[TextToSpeech] 等待 Edge TTS 服务初始化...');
      await edgeTTSService.init();
    }

    const isAvailable = edgeTTSService.isAvailable();
    console.log('[TextToSpeech] Edge TTS 服务状态:', isAvailable ? '可用' : '不可用');

    if (isAvailable) {
      this.setState({ isEdgeTtsAvailable: true });
      
      // 将 Edge TTS 语音添加到 this.voices 数组
      const edgeVoices = edgeTTSService.getAllVoices();
      console.log('[TextToSpeech] Edge TTS 语音数量:', edgeVoices.length);
      
      // 先过滤掉已存在的 edge-tts 语音（避免重复添加）
      this.voices = this.voices.filter(v => v.plugin !== 'edge-tts');
      this.voices = [...this.voices, ...edgeVoices];
      console.log('[TextToSpeech] 总语音数:', this.voices.length);
    } else {
      this.setState({ isEdgeTtsAvailable: false });
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
      TTSUtil.clearEdgeTtsAudio(bookName);
    }
  }

  UNSAFE_componentWillReceiveProps(
    nextProps: Readonly<TextToSpeechProps>,
    nextContext: any
  ): void {
    //plugin更新后重新获取语音列表
    if (nextProps.plugins !== this.props.plugins) {
      this.customVoices = TTSUtil.getVoiceList(nextProps.plugins);

      // 重新构建语音列表，保留Edge TTS语音（如果可用）
      const edgeTtsVoices = this.voices.filter(v => v.plugin === 'edge-tts');
      this.voices = [...this.nativeVoices, ...this.customVoices];

      // 重新添加Edge TTS语音
      if (edgeTtsVoices.length > 0) {
        this.voices = [...this.voices, ...edgeTtsVoices];
      }

      this.handleVoiceLocaleList();
    }
    if (nextProps.currentBook?.key !== this.props.currentBook?.key) {
      // 书籍切换时，清除旧书的缓存
      const oldBookName = this.props.currentBook?.name;
      if (oldBookName) {
        console.log('[TextToSpeech] 书籍切换，清除旧书缓存:', oldBookName);
        TTSUtil.clearEdgeTtsAudio(oldBookName);
      }
      
      this.setState({
        multiRoleEnabled: ConfigService.getAllListConfig(
          "multiRoleVoiceBooks"
        ).includes(nextProps.currentBook?.key),
      });
    }
  }

  handleMultiRoleToggle = (enabled: boolean) => {
    if (enabled) {
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
    window.speechSynthesis && window.speechSynthesis.cancel();
    await TTSUtil.pauseAudio();
    // 暂停播放不清除缓存，保留已生成的音频文件
    this.setState({ isPaused: true });
  };
  handleStop = async () => {
    window.speechSynthesis && window.speechSynthesis.cancel();
    await TTSUtil.stopAudio();
    // 停止播放时清理当前书本的缓存
    const bookName = this.props.currentBook?.name;
    await TTSUtil.clearEdgeTtsAudio(bookName);
    this.setState({ isAudioOn: false, isPaused: false, currentIndex: 0 });
    this.nodeList = [];
  };
  handlePauseResume = () => {
    // Resume from current index
    this.setState({ isPaused: false }, () => {
      if (this.nodeList[this.state.currentIndex].voiceEngine !== "system") {
        this.handleCustomRead(this.state.currentIndex);
      } else {
        this.handleSystemRead(this.state.currentIndex);
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
    console.log(this.nodeList, "nodelist");
    if (this.nodeList[0].voiceEngine !== "system") {
      await this.handleCustomRead(0);
    } else {
      await this.handleSystemRead(0);
    }
  };
  handleGetText = async () => {
    if (ConfigService.getReaderConfig("isSliding") === "yes") {
      await sleep(1000);
    }
    let nodeList = [];
    let nodeTextList = (await this.props.htmlBook.rendition.audioText()).filter(
      (item: string) => item && item.trim()
    );
    if (!this.state.multiRoleEnabled || !this.props.isAuthed) {
      if (
        this.props.currentBook.format === "PDF" &&
        ConfigService.getReaderConfig("isConvertPDF") !== "yes"
      ) {
      } else {
        let rawNodeList = nodeTextList.map((text) => {
          return splitSentences(text);
        });

        // Filter out empty or whitespace-only strings
        nodeTextList = rawNodeList.flat().filter((t) => t && t.trim());
      }
      nodeList = nodeTextList.map((text: string) => {
        return {
          text,
          voiceName: ConfigService.getReaderConfig("voiceName"),
          voiceEngine: ConfigService.getReaderConfig("voiceEngine"),
        };
      });
    } else {
      toast.loading(this.props.t("Analyzing roles, please wait..."), {
        id: "tts-analysis",
      });
      if (nodeTextList.join("").length > 50000) {
        toast.error(this.props.t("The text is too long to analyze"));
        this.setState({ isAudioOn: false });
        return [];
      }
      let res = await getSplitSentence(nodeTextList);
      console.log(res, "res");
      toast.dismiss("tts-analysis");
      let narratorVoice = this.state.multiRoleNarratorVoice;
      let narratorEngine = this.state.multiRoleNarratorEngine;
      let maleVoice = this.state.multiRoleMaleVoice;
      let maleEngine = this.state.multiRoleMaleEngine;
      let femaleVoice = this.state.multiRoleFemaleVoice;
      let femaleEngine = this.state.multiRoleFemaleEngine;
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
          }
          return {
            text: item.text,
            voiceName,
            voiceEngine,
          };
        });
        console.log(nodeList, "nodeList");
      } else {
        toast.error(this.props.t("Analysis failed"));
      }
    }

    if (nodeList.length === 0) {
      if (
        this.props.currentBook.format === "PDF" &&
        ConfigService.getReaderConfig("isConvertPDF") !== "yes"
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
      // 开始播放前清除所有缓存
      await TTSUtil.clearEdgeTtsAudio();
    }

    for (let index = nodeIndex; index < this.nodeList.length; index++) {
      if (this.state.isPaused || !this.state.isAudioOn) return;
      this.setState({ currentIndex: index });
      let node = this.nodeList[index];
      let style = "background: #f3a6a68c;";
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
          5,
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
        10,
        false,
        node.voiceEngine === "official-ai-voice-plugin",
        pageIndex,
        undefined, // part参数
        false // isCriticalPart: 预缓存的部分不是重要的
      );
      let res = await this.handleSpeech(index);
      console.log(res, "dfgghgfh");
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
        ConfigService.getReaderConfig("isConvertPDF") !== "yes"
      ) {
      } else {
        let rawNodeList = visibleTextList.map((text) => {
          return splitSentences(text);
        });

        lastVisibleTextList = rawNodeList.flat();
      }
      console.log(lastVisibleTextList, this.nodeList, "dfghfgjdfjjhgj");
      let isReachPageEnd =
        this.nodeList[index].text ===
        lastVisibleTextList[lastVisibleTextList.length - 1];
      if (this.state.multiRoleEnabled) {
        isReachPageEnd =
          trimSpecialCharacters(this.nodeList[index].text).includes(
            trimSpecialCharacters(
              lastVisibleTextList[lastVisibleTextList.length - 1]
            )
          ) ||
          trimSpecialCharacters(
            lastVisibleTextList[lastVisibleTextList.length - 1]
          ).includes(trimSpecialCharacters(this.nodeList[index].text));
      }
      if (index === this.nodeList.length - 1) {
        isReachPageEnd = true;
      }

      if (isReachPageEnd) {
        if (
          this.props.currentBook.format === "PDF" &&
          ConfigService.getReaderConfig("isConvertPDF") !== "yes"
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
    // 当前页的所有部分播放完成，清除缓存
    if (this.nodeList[this.state.currentIndex]?.voiceEngine === "edge-tts") {
      await TTSUtil.clearEdgeTtsAudio();
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
    let style = "background: #f3a6a68c;";
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
        ConfigService.getReaderConfig("isConvertPDF") !== "yes"
      ) {
      } else {
        let rawNodeList = visibleTextList.map((text) => {
          return splitSentences(text);
        });

        lastVisibleTextList = rawNodeList.flat();
      }
      let isReachPageEnd =
        this.nodeList[index].text ===
        lastVisibleTextList[lastVisibleTextList.length - 1];
      if (this.state.multiRoleEnabled) {
        isReachPageEnd =
          trimSpecialCharacters(this.nodeList[index].text).includes(
            trimSpecialCharacters(
              lastVisibleTextList[lastVisibleTextList.length - 1]
            )
          ) ||
          trimSpecialCharacters(
            lastVisibleTextList[lastVisibleTextList.length - 1]
          ).includes(trimSpecialCharacters(this.nodeList[index].text));
      }
      if (index === this.nodeList.length - 1) {
        isReachPageEnd = true;
      }
      if (isReachPageEnd) {
        if (
          this.props.currentBook.format === "PDF" &&
          ConfigService.getReaderConfig("isConvertPDF") !== "yes"
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
      console.log(
        this.nativeVoices.find((voice: any) => voice.name === voiceName),
        "afdfsd"
      );
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
      edgeTtsVoices: this.voices.filter(v => v.plugin === 'edge-tts').length,
      edgeTtsApiAvailable: this.state.isEdgeTtsAvailable
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
              backgroundColor: this.state.isEdgeTtsAvailable
                ? "rgba(100, 150, 255, 0.1)"
                : "rgba(255, 150, 100, 0.1)",
              borderRadius: "6px",
              fontSize: "11px",
              lineHeight: "1.4",
            }}
          >
            <div style={{ fontWeight: 500, marginBottom: "3px" }}>
              {this.state.isEdgeTtsAvailable
                ? "💡 Edge TTS 可用"
                : "⚠️ Edge TTS 不可用"}
            </div>
            <div>
              {this.state.isEdgeTtsAvailable
                ? "Edge TTS 服务正常，可选择 Edge TTS 语音进行播放"
                : "Edge TTS 服务不可用，请检查网络连接"}
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
                  {displayName}
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
          <Trans>Voice</Trans>
          <select
            name=""
            className="lang-setting-dropdown"
            id="text-speech-voice"
            onChange={(event) => {
              let selectedValue = event.target.value;
              let [voiceName, plugin] = selectedValue.split("#");
              ConfigService.setReaderConfig("voiceName", voiceName);
              let voice = this.voices.find(
                (item) => item.name === voiceName && item.plugin === plugin
              );
              if (!voice) {
                return;
              }
              console.log(voice, "voice");
              if (voice.plugin) {
                ConfigService.setReaderConfig("voiceEngine", voice.plugin);
              } else {
                ConfigService.setReaderConfig("voiceEngine", "system");
              }
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

              if (this.state.isAudioOn) {
                toast(this.props.t("Take effect in a while"));
              }
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
                  const isEdgeTts = item.plugin === "edge-tts";
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
                      {isEdgeTts ? "🎙️ " : ""}
                      {this.props.t(item.displayName || item.FriendlyName || item.name)}
                      {isEdgeTts ? " (Edge)" : ""}
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
            onChange={(event) => {
              ConfigService.setReaderConfig("voiceSpeed", event.target.value);
              if (this.state.isAudioOn) {
                toast(this.props.t("Take effect in a while"));
              }
            }}
          >
            {speedList.option.map((item) => (
              <option
                value={item.value}
                className="lang-setting-option"
                key={item.value}
                selected={
                  item.value ===
                  (ConfigService.getReaderConfig("voiceSpeed") || "1")
                }
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
              if (!this.props.isAuthed) {
                toast(
                  this.props.t("Please upgrade to Pro to use this feature")
                );
                this.props.handleSetting(true);
                this.props.handleSettingMode("account");
                return;
              }
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
                <option
                  value="system"
                  className="lang-setting-option"
                  selected={this.state.multiRoleVoiceType === "system"}
                >
                  {this.props.t("System voice")}
                </option>
                <option
                  value="edge-tts"
                  className="lang-setting-option"
                  selected={this.state.multiRoleVoiceType === "edge-tts"}
                >
                  {this.props.t("Edge TTS")}
                </option>
                <option
                  value="official-ai-voice-plugin"
                  className="lang-setting-option"
                  selected={
                    this.state.multiRoleVoiceType === "official-ai-voice-plugin"
                  }
                >
                  {this.props.t("Official AI Voice")}
                </option>
                <option
                  value="custom"
                  className="lang-setting-option"
                  selected={this.state.multiRoleVoiceType === "custom"}
                >
                  {this.props.t("Custom voice")}
                </option>
              </select>
            </div>
            {/* Narrator voice */}
            <div
              className="setting-dialog-new-title"
              style={{ marginLeft: "20px", width: "88%", fontWeight: 500 }}
            >
              <Trans>Narrator voice</Trans>
              <select
                name=""
                className="lang-setting-dropdown"
                id="multi-role-narrator-voice"
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
                      selected={item.name === this.state.multiRoleNarratorVoice}
                    >
                      {item.plugin === "edge-tts" ? "🎙️ " : ""}
                      {this.props.t(item.displayName || item.FriendlyName || item.name)}
                      {item.plugin === "edge-tts" ? " (Edge)" : ""}
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
              <Trans>Male voice</Trans>
              <select
                name=""
                className="lang-setting-dropdown"
                id="multi-role-male-voice"
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
                      selected={item.name === this.state.multiRoleMaleVoice}
                    >
                      {item.plugin === "edge-tts" ? "🎙️ " : ""}
                      {this.props.t(item.displayName || item.FriendlyName || item.name)}
                      {item.plugin === "edge-tts" ? " (Edge)" : ""}
                    </option>
                  ))}
              </select>
            </div>
            {/* Female voice */}
            <div
              className="setting-dialog-new-title"
              style={{ marginLeft: "20px", width: "88%", fontWeight: 500 }}
            >
              <Trans>Female voice</Trans>
              <select
                name=""
                className="lang-setting-dropdown"
                id="multi-role-female-voice"
                onChange={(event) => {
                  console.log(event.target.value);
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
                      selected={item.name === this.state.multiRoleFemaleVoice}
                    >
                      {item.plugin === "edge-tts" ? "🎙️ " : ""}
                      {this.props.t(item.displayName || item.FriendlyName || item.name)}
                      {item.plugin === "edge-tts" ? " (Edge)" : ""}
                    </option>
                  ))}
              </select>
            </div>
          </>
        )}
      </>
    );
  }
}

export default TextToSpeech;
