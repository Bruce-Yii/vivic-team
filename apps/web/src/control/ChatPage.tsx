import { useEffect, useState, type ReactNode } from "react";
import { HarkIcon } from "@/components/hark/HarkPrimitives";
import type { ResolvedCard } from "@/commands/references";
import type { Attachment } from "@/ai/attachments";
import { getVoiceConfiguration } from "@/ai/voiceConfig";
import type { ControlHost } from "@/sync/controlHost";
import { ChatComposer, type ClarifyState } from "./ChatComposer";
import { ChatStatusLine } from "./ChatStatusLine";
import { UserCardLayer, useUserPageDrop } from "./UserCardLayer";
import { UserCanvasControls } from "./UserCanvasControls";
import { ConnectedSources } from "@/connections/ConnectedSources";
import { FileUploadButton } from "@/files/FileUploadButton";
import { ReminderCenter } from "./ReminderCenter";
import {
  startFullDuplex,
  stopFullDuplex,
  subscribeFullDuplex,
  getFullDuplexSnapshot,
  setFullDuplexCommandHandler,
  interruptByUi,
  type FullDuplexCommandOptions,
} from "@/ai/fullDuplex";

interface ChatPageProps {
  hidden: boolean;
  host: ControlHost;
  theme: "light" | "dark";
  feedback: string | null;
  notice?: ReactNode;
  disabled: boolean;
  ownerKey: string;
  clarify: ClarifyState | null;
  suggestions: string[];
  backendOnline: boolean | null;
  busy: boolean;
  onSubmit: (text: string, attachments?: Attachment[], options?: FullDuplexCommandOptions) => void;
  onPickClarify: (candidate: ResolvedCard) => void;
  onPreviewClarify: (candidate: ResolvedCard) => void;
  onCancelClarify: () => void;
  onCancel: () => void;
  onOpenSettings: () => void;
  onOpenServices: () => void;
  onOpenDisplay: (canvasId?: string) => void;
}

const STATUS_VISIBLE_MS = 6000;
const QUIET_SUCCESS_FEEDBACK = new Set(["已保存", "已完成。", "已完成并保存。"]);

/**
 * 用户使用页: the shared background, settings and Space controls
 * and one text/voice input. No conversation is kept — results appear on the
 * Display. Cards the user drags in from the Display float where they land.
 */
export const ChatPage = ({ hidden, host, theme, feedback, notice, onOpenSettings, onOpenServices, onOpenDisplay, ...composer }: ChatPageProps) => {
  const drop = useUserPageDrop(host);
  const [fd, setFd] = useState(getFullDuplexSnapshot());
  useEffect(() => { const unsub = subscribeFullDuplex(() => setFd(getFullDuplexSnapshot())); return () => { unsub(); }; }, []);
  useEffect(() => {
    setFullDuplexCommandHandler((text: string, options?: FullDuplexCommandOptions) => {
      const mergedText = options?.constraints?.length
        ? `${text}（补充约束：${options.constraints.join("；")}）`
        : text;
      composer.onSubmit(mergedText, undefined, options);
    });
    return () => setFullDuplexCommandHandler(null);
  }, [composer.onSubmit]);
  const [fileMessage, setFileMessage] = useState("");
  useEffect(() => {
    if (!fileMessage.startsWith("已保存")) return;
    const timer = setTimeout(() => setFileMessage(""), STATUS_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [fileMessage]);
  // One transient status line (progress, a question, an error), never a log.
  const displayFeedback = feedback && !QUIET_SUCCESS_FEEDBACK.has(feedback.trim()) ? feedback : null;
  const [fresh, setFresh] = useState(false);
  const sticky = composer.busy || Boolean(composer.clarify);
  useEffect(() => {
    // Reveal each new status, then let it fade; the text stays for assistive tech.
    // oxlint-disable-next-line react/set-state-in-effect
    setFresh(Boolean(displayFeedback));
    if (!displayFeedback) return;
    const timer = setTimeout(() => setFresh(false), STATUS_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [displayFeedback]);

  return (
    <div className="vivic-chat" hidden={hidden} data-vivic-chat {...drop.handlers}>
      <UserCardLayer host={host} theme={theme} layerRef={drop.layerRef} receiving={drop.receiving} notice={drop.notice} onNotice={drop.setNotice} />
      {fd.status !== "idle" && <div data-vivic-fd-status style={{position:"fixed",bottom:12,left:12,zIndex:50,background:"rgba(0,0,0,.7)",color:"#fff",padding:"6px 10px",borderRadius:8,fontSize:12,maxWidth:320}}>
        FD #{fd.turnId}: {fd.status} {fd.userSpeaking?"(user)":""} {fd.aiSpeaking?"(ai)":""}<br/>
        {fd.lastTranscript ? `“${fd.lastTranscript}” → ${fd.lastIntent}` : ""}
        {fd.pendingConstraints.length > 0 ? <><br/>待应用约束: {fd.pendingConstraints.length}</> : null}
        {fd.task ? <><br/>任务 {fd.task.status} · step {fd.task.step}
          {fd.task.executionId ? ` · ${fd.task.executionId.slice(0, 8)}` : ""}
          {typeof fd.task.canvasVersion === "number" ? ` · v${fd.task.canvasVersion}` : ""}
          {fd.task.mutationClass !== "unknown" ? ` · ${fd.task.mutationClass}` : ""}</> : null}
        {fd.error ? `错误: ${fd.error}` : ""}
      </div>}
      <header className="vivic-chat-header">
        <div className="vivic-header-start">
          <button type="button" className="vivic-round-button" onClick={() => { interruptByUi("navigation"); onOpenSettings(); }}
            aria-label="设置" title="设置" data-vivic-open-settings>
            <HarkIcon name="gear" size={20} aria-hidden="true" />
          </button>
          <button type="button" className="vivic-round-button" onClick={() => { interruptByUi("navigation"); onOpenServices(); }}
            aria-label="应用与生活服务" title="应用与生活服务" data-vivic-open-services>
            <HarkIcon name="apps" size={20} aria-hidden="true" />
          </button>
          <ReminderCenter host={host} disabled={composer.disabled} theme={theme} />
        <button
          type="button"
          className="vivic-round-button"
          onClick={() => {
            if (fd.enabled) {
              stopFullDuplex();
            } else {
              const stt = getVoiceConfiguration().stt;
              void startFullDuplex({ asr: { provider: stt === "stepfun" || stt === "local" ? stt : "mock" } });
            }
          }}
          aria-label="全双工语音"
          title={fd.enabled ? `全双工开启：${fd.status}` : "开启全双工语音"}
          data-vivic-full-duplex
        >
          <span style={{fontSize:10}}>{fd.enabled ? "FD" : "fd"}</span>
        </button>
        </div>
        <UserCanvasControls host={host} theme={theme} onOpenDisplay={onOpenDisplay} />
        {notice}
      </header>
      <div className="vivic-chat-space" />
      <div className="vivic-chat-footer">
        {fileMessage && <p className="vivic-file-message vivic-upload-status" role="status">{fileMessage}</p>}
        <ChatStatusLine text={displayFeedback} visible={fresh || sticky} busy={composer.busy} onCancel={composer.onCancel} />
        <ChatComposer {...composer} onOpenConnectionSettings={() => {
          interruptByUi("navigation");
          if (window.location.hash !== "#settings-connections") window.location.hash = "#settings-connections";
          onOpenSettings();
        }} menuActions={close => <>
          <FileUploadButton host={host} disabled={composer.disabled || composer.busy} compact onPick={close} onStatus={setFileMessage} />
          <ConnectedSources host={host} disabled={composer.disabled} onConfigure={onOpenServices} />
        </>} />
      </div>
    </div>
  );
};
