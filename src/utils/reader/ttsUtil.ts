import { Howl } from "howler";
import { isElectron } from "react-device-detect";
import PluginModel from "../../models/Plugin";
import { getAllVoices, getFormatFromAudioPath } from "../common";
import { getTTSAudio } from "../request/reader";

class TTSUtil {
  static player: any;
  static currentAudioPath: string = "";
  static audioPaths: { index: number; audioPath: string }[] = [];
  static isPaused: boolean = false;
  static processingIndexes: Set<number> = new Set();
  static currentBookName: string = "";
  static currentChapterIndex: number = 0;
  static isPlaying: boolean = false; // 跟踪是否有音频正在播放

  static async readAloud(currentIndex: number) {
    // 如果当前有音频正在播放，先停止
    if (this.isPlaying && this.player) {
      console.log("TTSUtil: Stopping current audio before playing new one");
      this.player.stop();
      this.player = null;
    }

    this.isPlaying = true;

    return new Promise<string>(async (resolve) => {
      console.log("TTSUtil readAloud:", this.audioPaths, currentIndex);
      let audioPath = this.audioPaths.find(
        (item) => item.index === currentIndex
      )?.audioPath;
      if (!audioPath) {
        console.warn(
          "TTSUtil: No audio path found for index",
          currentIndex,
          "- skipping this part"
        );
        this.isPlaying = false;
        resolve("skip");
        return;
      }

      console.log("TTSUtil: Raw audio path:", audioPath);

      // Convert local file path to proper file:// URL
      let audioSrc = audioPath;
      if (audioPath.startsWith("/")) {
        // Convert absolute path to file:// URL
        audioSrc = "file://" + audioPath;
      }

      console.log("TTSUtil: Audio src for Howler:", audioSrc);

      var sound = new Howl({
        src: [audioSrc],
        format: [getFormatFromAudioPath(audioPath)],
        html5: true, // Force HTML5 Audio to support local files
        onloaderror: (e) => {
          console.error("TTSUtil: Audio load error:", e);
          this.isPlaying = false;
          resolve("skip");
        },
        onload: async () => {
          console.log("TTSUtil: Audio loaded successfully, playing...");
          this.player.play();
          resolve("load");
        },
        onplayerror: (e) => {
          console.error("TTSUtil: Audio play error:", e);
          this.isPlaying = false;
          resolve("skip");
        },
        onend: () => {
          console.log("TTSUtil: Audio playback ended");
          this.isPlaying = false;
        },
      });
      this.player = sound;
    });
  }
  static async cacheAudio(
    startIndex: number,
    speed: number,
    plugins: PluginModel[],
    audioNodeList: {
      text: string;
      voiceName: string;
      voiceEngine: string;
    }[],
    targetCacheCount: number,
    isFirst: boolean,
    isOfficialAIVoice: boolean,
    pageIndex?: number,
    part?: number,
    isCriticalPart: boolean = false
  ) {
    console.log("TTSUtil cacheAudio called:", {
      startIndex,
      speed,
      isOfficialAIVoice,
      isFirst,
      engine: audioNodeList[startIndex]?.voiceEngine,
      voice: audioNodeList[startIndex]?.voiceName,
    });
    this.isPaused = false;

    // 如果是第一次调用（开始播放），只生成第一个文件就立即返回
    // 然后在后台异步继续缓存后续文件
    if (isFirst) {
      const firstIndex = startIndex;
      if (firstIndex >= audioNodeList.length) {
        return; // 没有更多文本了
      }

      const audioNode = audioNodeList[firstIndex];

      // 如果是 Edge TTS 或非官方 AI 语音，直接生成
      if (audioNode.voiceEngine !== "official-ai-voice-plugin") {
        let plugin: any = null;
        let voice: any = null;

        if (audioNode.voiceEngine !== "edge-tts") {
          plugin = plugins.find((item) => item.key === audioNode.voiceEngine);
          if (!plugin) {
            console.error(
              `Plugin not found for engine: ${audioNode.voiceEngine}`
            );
            return "error";
          }
          voice = (plugin.voiceList as any[]).find(
            (voice) => voice.name === audioNode.voiceName
          );
          if (!voice) {
            console.error(`Voice not found: ${audioNode.voiceName}`);
            return "error";
          }
        } else {
          plugin = { voiceName: audioNode.voiceName };
        }

        // 生成第一个音频文件
        let audioPath = await this.getAudioPath(
          audioNode.text,
          speed,
          audioNode.voiceEngine,
          plugin,
          voice,
          isFirst,
          pageIndex,
          firstIndex
        );

        this.processingIndexes.delete(firstIndex);

        if (audioPath) {
          this.audioPaths.push({ index: firstIndex, audioPath: audioPath });
          console.log(
            `[TTS] First audio generated for index ${firstIndex}, returning immediately`
          );
          // 第一个文件生成完成，立即返回
          // 在后台异步缓存后续文件
          this.cacheAudioAsync(
            startIndex + 1,
            speed,
            plugins,
            audioNodeList,
            targetCacheCount - 1,
            false,
            isOfficialAIVoice,
            pageIndex
          );
          return; // 不返回任何值，表示成功
        } else {
          console.warn(
            `[TTS] First audio generation failed for index ${firstIndex}`
          );
          return; // 返回空，表示失败但可以继续
        }
      } else {
        // 官方 AI 语音的处理逻辑
        // 等待第一个文件生成完成
        const result = await this.cacheSingleAudio(
          firstIndex,
          speed,
          plugins,
          audioNodeList,
          isFirst,
          pageIndex
        );

        if (result === "error") {
          return "error";
        }

        // 第一个文件生成完成，立即返回
        // 在后台异步缓存后续文件
        this.cacheAudioAsync(
          startIndex + 1,
          speed,
          plugins,
          audioNodeList,
          targetCacheCount - 1,
          false,
          isOfficialAIVoice,
          pageIndex
        );
        return; // 不返回任何值，表示成功
      }
    }

    // 如果不是第一次调用（预缓存），使用原有逻辑
    if (isOfficialAIVoice) {
      const cacheCount = Math.min(
        targetCacheCount,
        audioNodeList.length - startIndex
      );
      // 并发执行，并发数量为3，但保证添加顺序
      const CONCURRENT_LIMIT = 5;
      //删除index小于startIndex的缓存
      this.audioPaths = this.audioPaths.filter(
        (item) => item.index >= startIndex - 5
      );

      for (let i = 0; i < cacheCount; i += CONCURRENT_LIMIT) {
        const batch: any[] = [];

        for (let j = 0; j < CONCURRENT_LIMIT && i + j < cacheCount; j++) {
          const index = startIndex + i + j;
          if (index >= audioNodeList.length) break;

          // 如果已经缓存过或正在处理中，跳过
          if (
            this.audioPaths.find((item) => item.index === index) ||
            this.processingIndexes.has(index)
          ) {
            continue;
          }

          // 标记为正在处理
          this.processingIndexes.add(index);

          const audioNode = audioNodeList[index];
          let plugin = plugins.find(
            (item) => item.key === audioNode.voiceEngine
          );
          console.log(plugins, audioNode);
          if (!plugin) {
            return "error";
          }
          let voice = (plugin.voiceList as any[]).find(
            (voice) => voice.name === audioNode.voiceName
          );
          console.log(plugin.voiceList, audioNode, "asf");
          if (!voice) {
            return "error";
          }
          // 创建异步任务
          const task = this.getAudioPath(
            audioNode.text,
            speed,
            audioNode.voiceEngine,
            plugin,
            voice,
            isFirst,
            pageIndex,
            index // 使用index作为part参数
          )
            .then(async (res) => {
              // 处理完成后，从处理集合中移除
              this.processingIndexes.delete(index);
              if (res) {
                return { index, audioPath: res };
              } else {
                // 返回空字符串时不中断流程，只记录日志
                console.warn(
                  `[TTS] getAudioPath returned empty for index ${index}, skipping`
                );
                return null;
              }
            })
            .catch((error) => {
              // 出错时也要从处理集合中移除
              this.processingIndexes.delete(index);
              console.error(`Error caching audio for index ${index}:`, error);
              return null;
            });
          batch.push(task);
        }

        // 等待当前批次完成
        const batchResults = await Promise.all(batch);

        // 将结果存储到 Map 中
        for (const result of batchResults) {
          if (result) {
            if (this.audioPaths.find((item) => item.index === result.index)) {
              this.audioPaths = this.audioPaths.map((item) => {
                if (item.index === result.index) {
                  return result;
                } else {
                  return item;
                }
              });
            } else {
              this.audioPaths.push(result);
            }
          } else {
            // 对于预缓存的部分失败，不中断流程，只记录日志
            console.warn(
              `[TTS] Audio generation failed for pre-cache part, but continuing playback`
            );
            // 不设置 this.isPaused = true，继续处理其他部分
          }
        }
      }
    } else {
      let maxCacheIndex = Math.min(
        startIndex + targetCacheCount,
        audioNodeList.length
      );
      for (let index = startIndex; index < maxCacheIndex; index++) {
        if (this.isPaused) {
          break;
        }
        // 如果已经缓存过或正在处理中，跳过
        if (
          this.audioPaths.find((item) => item.index === index) ||
          this.processingIndexes.has(index)
        ) {
          continue;
        }
        // 标记为正在处理
        this.processingIndexes.add(index);
        const audioNode = audioNodeList[index];

        // 核心修复：跳过空文本或空白字符节点，防止 edgetts 报错
        if (!audioNode.text || !audioNode.text.trim()) {
          console.log(`Skipping empty text node at index ${index}`);
          this.processingIndexes.delete(index);
          continue;
        }

        // Edge TTS doesn't have a plugin, handle it specially
        let plugin: any = null;
        let voice: any = null;

        if (audioNode.voiceEngine !== "edge-tts") {
          plugin = plugins.find((item) => item.key === audioNode.voiceEngine);
          if (!plugin) {
            this.processingIndexes.delete(index);
            return "error";
          }
          voice = (plugin.voiceList as any[]).find(
            (voice) => voice.name === audioNode.voiceName
          );
          if (!voice) {
            this.processingIndexes.delete(index);
            return "error";
          }
        } else {
          // For Edge TTS, pass voiceName through plugin object
          plugin = { voiceName: audioNode.voiceName };
        }

        let audioPath = await this.getAudioPath(
          audioNode.text,
          speed,
          audioNode.voiceEngine,
          plugin,
          voice,
          isFirst,
          pageIndex,
          index // 使用index作为part参数
        );
        // 处理完成后，从处理集合中移除
        this.processingIndexes.delete(index);
        if (audioPath) {
          this.audioPaths.push({ index: index, audioPath: audioPath });
        } else {
          if (isCriticalPart && index === startIndex) {
            // 如果是重要部分且是起始部分失败，才中断
            this.isPaused = true;
            break;
          } else {
            // 非重要部分或非起始部分失败，只记录日志，继续处理
            console.warn(
              `[TTS] Audio generation failed for part ${index}, but continuing`
            );
          }
        }
      }
    }
  }
  static async pauseAudio() {
    if (this.player && this.player.stop) {
      this.player.stop();
      this.isPaused = true;
    }
  }
  static async stopAudio() {
    if (this.player && this.player.stop) {
      this.player.stop();
      this.isPaused = true;
      setTimeout(() => {
        this.clearAudioPaths();
        this.audioPaths = [];
        this.processingIndexes.clear();
      }, 1000);
    }
  }
  static async clearAudioPaths() {
    if (!isElectron) return;
    window.require("electron").ipcRenderer.invoke("clear-tts");
  }

  static async clearEdgeTtsAudio(bookName?: string) {
    if (!isElectron) return;
    try {
      await window
        .require("electron")
        .ipcRenderer.invoke("clear-edge-tts-audio", bookName ? { bookName } : {});
    } catch (error) {
      console.error("Error clearing Edge TTS audio:", error);
    }
  }
  static getAudioPaths() {
    return this.audioPaths;
  }
  static async getAudioPath(
    text: string,
    speed: number,
    voiceEngine: string,
    plugin,
    voice,
    isFirst: boolean,
    pageIndex?: number,
    part?: number
  ) {
    if (voiceEngine === "official-ai-voice-plugin") {
      console.log(text, voice);
      let res = await getTTSAudio(
        text,
        voice.language,
        voice.name,
        (speed + 100) / 100,
        1.0,
        isFirst
      );
      console.log(res);
      if (res && res.data && res.data.audio_base64) {
        return res.data.audio_base64;
      }
      return "";
    } else if (voiceEngine === "edge-tts") {
      // Use built-in Edge TTS
      console.log('[TTSUtil.getAudioPath] Edge TTS 调用参数:', {
        bookName: this.currentBookName,
        chapterIndex: this.currentChapterIndex,
        part: part,
        voiceName: plugin ? plugin.voiceName : 'zh-CN-XiaoxiaoNeural',
      });

      let audioPath = await window
        .require("electron")
        .ipcRenderer.invoke("generate-edge-tts", {
          text: text,
          speed: (speed + 100) / 100,
          voiceName: plugin ? plugin.voiceName : 'zh-CN-XiaoxiaoNeural',
          pageIndex: pageIndex,
          part: part,
          bookName: this.currentBookName || 'unknown',
          chapterIndex: this.currentChapterIndex !== undefined ? this.currentChapterIndex : 0,
        });
      return audioPath;
    } else {
      let audioPath = await window
        .require("electron")
        .ipcRenderer.invoke("generate-tts", {
          text: text,
          speed,
          plugin: plugin,
          config: voice.config,
        });
      return audioPath;
    }
  }
  static setAudioPaths() {
    this.audioPaths = [];
    this.processingIndexes.clear();
  }
  static getPlayer() {
    return this.player;
  }

  // 异步缓存后续音频文件（不阻塞主流程）
  static async cacheAudioAsync(
    startIndex: number,
    speed: number,
    plugins: PluginModel[],
    audioNodeList: {
      text: string;
      voiceName: string;
      voiceEngine: string;
    }[],
    targetCacheCount: number,
    isFirst: boolean,
    isOfficialAIVoice: boolean,
    pageIndex?: number
  ) {
    if (targetCacheCount <= 0 || startIndex >= audioNodeList.length) {
      return;
    }

    console.log(
      `[TTS] Starting async cache for ${targetCacheCount} files from index ${startIndex}`
    );

    // 调用原有的 cacheAudio 方法进行预缓存
    this.cacheAudio(
      startIndex,
      speed,
      plugins,
      audioNodeList,
      targetCacheCount,
      false, // 不是第一次调用
      isOfficialAIVoice,
      pageIndex
    ).catch((err) => {
      console.error("[TTS] Error in async cache:", err);
    });
  }

  // 缓存单个音频文件（用于官方AI语音）
  static async cacheSingleAudio(
    index: number,
    speed: number,
    plugins: PluginModel[],
    audioNodeList: {
      text: string;
      voiceName: string;
      voiceEngine: string;
    }[],
    isFirst: boolean,
    pageIndex?: number
  ): Promise<string | void> {
    if (index >= audioNodeList.length) {
      return;
    }

    const audioNode = audioNodeList[index];
    const plugin = plugins.find((item) => item.key === audioNode.voiceEngine);

    if (!plugin) {
      console.error(`Plugin not found for engine: ${audioNode.voiceEngine}`);
      return "error";
    }

    const voice = (plugin.voiceList as any[]).find(
      (voice) => voice.name === audioNode.voiceName
    );

    if (!voice) {
      console.error(`Voice not found: ${audioNode.voiceName}`);
      return "error";
    }

    this.processingIndexes.add(index);

    const audioPath = await this.getAudioPath(
      audioNode.text,
      speed,
      audioNode.voiceEngine,
      plugin,
      voice,
      isFirst,
      pageIndex,
      index
    );

    this.processingIndexes.delete(index);

    if (audioPath) {
      this.audioPaths.push({ index, audioPath });
      console.log(`[TTS] Audio cached for index ${index}`);
    } else {
      console.warn(`[TTS] Audio generation failed for index ${index}`);
    }
  }

  static getVoiceList(plugins: PluginModel[]) {
    let voices = getAllVoices(plugins);

    return voices;
  }

  static setCurrentBookInfo(bookName: string, chapterIndex: number = 0) {
    console.log('[TTSUtil.setCurrentBookInfo] 设置:', { bookName, chapterIndex });
    this.currentBookName = bookName;
    this.currentChapterIndex = chapterIndex;
  }
}
export default TTSUtil;
