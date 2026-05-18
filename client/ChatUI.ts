/**
 * client/ChatUI.ts
 *
 * Chat panel renderer and send handler.
 *
 * Pitfall-proof:
 * - Server already HTML-encodes messages. Client renders via textContent
 *   (NOT innerHTML) as a second defense — no XSS possible.
 * - Auto-scrolls only when already at bottom (don't hijack manual scroll).
 * - Enter key sends without form submission (no <form> in the HTML).
 * - Rate limiting enforced server-side; client just disables send briefly
 *   to give visual feedback without blocking UI.
 */

export interface ChatMessage {
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  isSystem?: boolean;
}

type SendFn = (text: string) => void;

export class ChatUI {
  private container: HTMLElement;
  private input: HTMLInputElement;
  private sendBtn: HTMLButtonElement;
  private sendFn: SendFn;
  private mySessionId: string = "";

  constructor(sendFn: SendFn) {
    this.sendFn = sendFn;

    this.container = document.getElementById("chat-messages")!;
    this.input = document.getElementById("chat-input") as HTMLInputElement;
    this.sendBtn = document.getElementById("chat-send") as HTMLButtonElement;

    this._bindEvents();
  }

  setMySessionId(id: string): void {
    this.mySessionId = id;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  addMessage(msg: ChatMessage): void {
    const atBottom = this._isAtBottom();

    const el = document.createElement("div");
    el.className = "chat-msg" + (msg.isSystem ? " system" : "");

    const sender = document.createElement("span");
    sender.className = "sender";
    // textContent — never innerHTML — safe against any leftover HTML entities
    sender.textContent = msg.senderName + ":";

    const text = document.createElement("span");
    text.className = "text";
    text.textContent = msg.text; // textContent: XSS-safe

    el.appendChild(sender);
    el.appendChild(text);
    this.container.appendChild(el);

    // Auto-scroll only if already at bottom (don't yank scroll position)
    if (atBottom) {
      this.container.scrollTop = this.container.scrollHeight;
    }

    // Keep DOM lean: max 200 messages
    while (this.container.children.length > 200) {
      this.container.removeChild(this.container.firstChild!);
    }
  }

  addSystemMessage(text: string): void {
    this.addMessage({
      senderId: "system",
      senderName: "System",
      text,
      timestamp: Date.now(),
      isSystem: true,
    });
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private _bindEvents(): void {
    this.sendBtn.addEventListener("click", () => this._send());

    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this._send();
      }
      // Prevent game keyboard shortcuts while typing in chat
      e.stopPropagation();
    });
  }

  private _send(): void {
    const text = this.input.value.trim();
    if (!text) return;

    this.input.value = "";
    this.sendFn(text);

    // Brief visual cooldown (server rate-limits; this just prevents button spam)
    this.sendBtn.disabled = true;
    setTimeout(() => { this.sendBtn.disabled = false; }, 350);
  }

  private _isAtBottom(): boolean {
    const { scrollTop, scrollHeight, clientHeight } = this.container;
    return scrollHeight - scrollTop - clientHeight < 40;
  }
}
