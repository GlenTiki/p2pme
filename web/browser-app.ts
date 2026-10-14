import type { ClientOptions, HostClient } from "../src/host-client.js";
import {
  type PairingInvitation,
  type ConnectionRecord,
} from "../src/rtc-identity.js";
import type { ProfileInfo, SessionInfo } from "../src/host-protocol.js";
import type { SurfaceAction } from "../src/surface.js";
import { createSurfaceMount } from "./surface.js";
import { createSurfaceDelivery } from "./surface-delivery.js";
import type { Envelope } from "../src/protocol.js";
import type { PairingLink } from "./pairing-link.js";
import {
  actionButton,
  createConversation,
  getElement,
  sessionList,
  profileList,
} from "./browser-view.js";
import {
  loadHosts,
  saveHost,
  forgetHost,
  forgetAllHosts,
  type HostStorage,
} from "./saved-hosts.js";

interface JoinAttempt {
  completion: Promise<ConnectionRecord>;
  close(): Promise<void>;
}
export interface BrowserDependencies {
  join(input: string | PairingInvitation, label: string): JoinAttempt;
  connect(
    record: ConnectionRecord,
    options: ClientOptions,
  ): Promise<HostClient>;
  copy(text: string): Promise<void>;
  storage: HostStorage;
}

class BrowserApp {
  private client: HostClient | null = null;
  private attempt: JoinAttempt | null = null;
  private saveCandidate: ConnectionRecord | null = null;
  private selected: SessionInfo | null = null;
  private generation = 0;
  private busy = false;
  private sending = false;
  private creating = false;
  private profiles: ProfileInfo[] = [];
  private connectionAbort: AbortController | null = null;
  private listeners: Array<() => void> = [];
  private readonly surface;
  private readonly delivery;
  private refreshSequence = 0;
  private refreshing = false;
  private readonly conversation;
  constructor(
    private readonly root: ParentNode,
    private readonly deps: BrowserDependencies,
    link: PairingLink,
  ) {
    this.surface = createSurfaceMount(this.element("session-surface"));
    this.delivery = createSurfaceDelivery({
      render: (sessionId, surface) => this.renderSurface(sessionId, surface),
      clear: () => this.clearSurface(),
      fail: (message) => this.feedback(message),
    });
    this.conversation = createConversation(this.element("messages"));
    this.bind("connect-form", "submit", () => this.pair());
    this.bind("disconnect-host", "click", () => this.disconnect());
    this.bind("message-form", "submit", () => this.send());
    this.bind("create-session-form", "submit", () => this.createSession());
    this.bind("refresh-sessions", "click", () => this.refreshCurrentSessions());
    this.bind("forget-all-hosts", "click", () => {
      forgetAllHosts(this.deps.storage);
      this.feedback("");
      this.renderHosts();
    });
    this.bind("copy-agent-prompt", "click", () => this.copy("agent-prompt"));
    this.bind("remember-connected-host", "click", () => {
      if (this.client && this.saveCandidate) this.remember(this.saveCandidate);
    });
    this.renderHosts();
    this.controls();
    this.openPairingLink(link);
  }
  openPairingLink(link: PairingLink) {
    if (link.kind === "none") return;
    if (this.busy || this.client) {
      this.feedback("Disconnect, then open the connection link again.");
      return;
    }
    if (link.kind === "invalid")
      this.feedback(
        "LINK_INVALID: This connection link is invalid. Request a new link from your agent.",
      );
    if (link.kind === "invitation") void this.pair(link.invitation);
  }
  private element<T extends HTMLElement>(id: string) {
    return getElement<T>(this.root, id);
  }
  private bind(id: string, event: string, action: () => void | Promise<void>) {
    const element = this.element(id);
    const listener = (event: Event) => {
      event.preventDefault();
      void this.run(action);
    };
    element.addEventListener(event, listener);
    this.listeners.push(() => element.removeEventListener(event, listener));
  }
  private async run(action: () => void | Promise<void>) {
    try {
      await action();
    } catch {
      this.feedback("The action failed. Check the host and try again.");
    }
  }
  private feedback(text: string) {
    this.element("app-feedback").textContent = text;
  }
  private status(text: string) {
    this.element("connection-status-text").textContent = text;
  }
  private controls() {
    this.element("remember-connected-host").hidden =
      this.client === null || this.saveCandidate === null;
    const ready =
      this.client !== null && this.selected !== null && this.selected.online;
    this.element<HTMLButtonElement>("connect-host").disabled =
      this.busy || this.client !== null;
    this.element<HTMLButtonElement>("disconnect-host").disabled =
      !this.busy && this.client === null;
    this.sessionControls();
    this.element<HTMLButtonElement>("send-message").disabled =
      !ready || this.sending;
    this.element<HTMLTextAreaElement>("message-input").disabled = !ready;
    this.element<HTMLInputElement>("delegate-task").disabled = !ready;
  }
  private sessionControls() {
    const canCreate = this.client !== null && this.profiles.length > 0;
    this.element("create-session-panel").hidden = !canCreate;
    this.element("session-context-status").hidden =
      this.client === null || canCreate;
    const creationDisabled = !canCreate || this.creating;
    this.element<HTMLButtonElement>("create-session").disabled =
      creationDisabled;
    this.element<HTMLSelectElement>("session-profile").disabled =
      creationDisabled;
    this.element<HTMLInputElement>("session-label").disabled = creationDisabled;
    this.element<HTMLButtonElement>("refresh-sessions").disabled =
      this.client === null || this.refreshing;
  }
  private renderHosts() {
    const list = this.element("host-list");
    list.replaceChildren();
    try {
      for (const host of loadHosts(this.deps.storage)) {
        const row = document.createElement("li");
        const label = document.createElement("span");
        const expired = Date.parse(host.expiresAt) <= Date.now();
        label.textContent = `${host.label} · ${host.hostId}${expired ? " · expired" : ""}`;
        const connect = actionButton("Connect", () => {
          void this.run(() => this.connectSaved(host.hostId));
        });
        connect.disabled = expired;
        row.append(
          label,
          connect,
          actionButton("Forget", () => {
            void this.run(() => {
              forgetHost(this.deps.storage, host.hostId);
              this.renderHosts();
            });
          }),
        );
        list.append(row);
      }
    } catch {
      this.feedback(
        "Saved host data is invalid or unavailable. Forget saved hosts, then pair again.",
      );
    }
    if (!list.children.length) {
      const item = document.createElement("li");
      item.textContent =
        "No saved hosts. Enter a code or open your agent’s QR link.";
      list.append(item);
    }
  }
  private async connectSaved(hostId: string) {
    const host = loadHosts(this.deps.storage).find(
      (record) => record.hostId === hostId,
    );
    if (!host) {
      this.feedback("This host was forgotten. Pair again to connect.");
      return;
    }
    await this.connect(host, false);
  }
  private async pair(invitation?: PairingInvitation) {
    if (this.busy || this.client) return;
    this.feedback("");
    const generation = ++this.generation;
    this.busy = true;
    this.controls();
    let attempt: JoinAttempt | undefined;
    let paired = false;
    try {
      const input =
        invitation ?? this.element<HTMLInputElement>("pairing-code").value;
      attempt = this.deps.join(
        input,
        this.element<HTMLInputElement>("device-label").value,
      );
      this.attempt = attempt;
      this.element<HTMLInputElement>("pairing-code").value = "";
      this.status("Pairing with host");
      const record = await attempt.completion;
      paired = true;
      if (generation !== this.generation) return;
      await this.establish(record, true, generation);
    } catch {
      if (generation === this.generation) {
        await this.disconnect();
        this.feedback(
          paired
            ? "HOST_UNREACHABLE: The device was paired, but the host connection failed. Keep the host online, then reconnect or ask for a new invitation."
            : "PAIRING_FAILED: Pairing did not complete. Keep the host online. Try the QR link or ask your agent for a new invitation.",
        );
      }
    } finally {
      await attempt?.close();
      if (this.attempt === attempt) this.attempt = null;
    }
  }
  private async connect(record: ConnectionRecord, remember: boolean) {
    if (this.busy || this.client) return;
    this.busy = true;
    this.controls();
    this.feedback("");
    const generation = ++this.generation;
    try {
      await this.establish(record, remember, generation);
    } catch {
      if (generation === this.generation) {
        await this.disconnect();
        this.feedback(
          "HOST_UNREACHABLE: The device was paired, but the host connection failed. Keep the host online, then reconnect or ask for a new invitation.",
        );
      }
    }
  }
  private async establish(
    record: ConnectionRecord,
    remember: boolean,
    generation: number,
  ) {
    this.status("Connecting to host");
    const abort = new AbortController();
    this.connectionAbort = abort;
    const client = await this.deps.connect(record, {
      signal: abort.signal,
      onEvent: (event) => this.receive(event, generation),
      onDisconnect: () => {
        if (generation === this.generation && this.client) {
          this.reset();
          this.feedback(
            "HOST_UNREACHABLE: The device was paired, but the host connection failed. Keep the host online, then reconnect or ask for a new invitation.",
          );
        }
      },
    });
    if (generation !== this.generation) {
      await client.close();
      return;
    }
    this.client = client;
    this.saveCandidate = remember ? record : null;
    this.busy = false;
    this.element("host-id").textContent = `Host ID: ${client.hostId}`;
    this.element("host-label").textContent = record.label;
    this.status("Connected to host");
    this.element<HTMLDetailsElement>("host-setup").open = false;
    this.controls();
    if (remember && this.element<HTMLInputElement>("remember-host").checked)
      this.remember(record);
    await this.refreshSessions(client, generation);
  }
  private remember(record: ConnectionRecord) {
    try {
      saveHost(this.deps.storage, record);
      this.saveCandidate = null;
      this.renderHosts();
      this.controls();
      this.feedback("Host remembered in this browser.");
    } catch {
      this.feedback(
        "Connected, but this browser could not save the host. Keep this tab open or pair again later.",
      );
    }
  }
  private async refreshSessions(client: HostClient, generation: number) {
    if (generation !== this.generation) return;
    const sequence = ++this.refreshSequence;
    this.refreshing = true;
    if (
      this.element("app-feedback").textContent?.startsWith(
        "SESSIONS_UNAVAILABLE:",
      )
    )
      this.feedback("");
    this.controls();
    try {
      await this.loadSessions(client, generation, sequence);
    } catch {
      if (generation === this.generation && sequence === this.refreshSequence) {
        this.setProfiles([]);
        this.feedback(
          "SESSIONS_UNAVAILABLE: Connected to the host, but sessions could not load. Select Refresh to try again.",
        );
      }
    } finally {
      if (generation === this.generation && sequence === this.refreshSequence) {
        this.refreshing = false;
        this.controls();
      }
    }
  }
  private async loadSessions(
    client: HostClient,
    generation: number,
    sequence: number,
  ) {
    const profileId = this.element<HTMLSelectElement>("session-profile").value;
    this.setProfiles([]);
    this.element("session-context-status").textContent =
      "Loading session contexts…";
    const sessions = sessionList(await client.request("sessions.list", {}));
    if (generation !== this.generation || sequence !== this.refreshSequence)
      return;
    const list = this.element("session-list");
    list.replaceChildren();
    for (const session of sessions) {
      const row = document.createElement("li");
      const button = actionButton(
        `${session.label} · ${session.provider}${session.online ? "" : " · offline"}`,
        () => this.select(session),
      );
      button.disabled = !session.online;
      row.append(button);
      list.append(row);
    }
    if (!sessions.length) {
      const item = document.createElement("li");
      item.textContent =
        "No registered sessions. Use the p2pme skill in your local agent.";
      list.append(item);
    }
    if (this.selected) this.updateSelected(sessions);
    this.controls();
    await this.refreshProfiles(client, generation, sequence, profileId);
    await this.refreshSurface();
  }
  private setProfiles(profiles: ProfileInfo[], selectedId = "") {
    this.profiles = profiles;
    const select = this.element<HTMLSelectElement>("session-profile");
    select.replaceChildren(
      ...profiles.map((profile) => {
        const option = document.createElement("option");
        option.value = profile.id;
        option.textContent = `${profile.id} · ${profile.provider}`;
        return option;
      }),
    );
    if (profiles.some((profile) => profile.id === selectedId))
      select.value = selectedId;
    this.element("session-context-status").textContent =
      "Session creation is unavailable. The host must provide contexts and grant creation access.";
    this.controls();
  }
  private async refreshProfiles(
    client: HostClient,
    generation: number,
    sequence: number,
    selectedId: string,
  ) {
    let profiles: ProfileInfo[];
    try {
      profiles = profileList(await client.request("profiles.list", {}));
    } catch {
      profiles = [];
    }
    if (generation !== this.generation || sequence !== this.refreshSequence)
      return;
    this.setProfiles(profiles, selectedId);
  }
  private async refreshCurrentSessions() {
    if (this.client) await this.refreshSessions(this.client, this.generation);
  }
  private updateSelected(sessions: SessionInfo[]) {
    const wasOnline = this.selected?.online;
    this.selected =
      sessions.find((session) => session.id === this.selected?.id) ?? null;
    if (!this.selected?.online) {
      this.delivery.select(null);
    } else if (!wasOnline) this.delivery.select(this.selected.id);
    this.element("selected-session").textContent = this.selected
      ? `${this.selected.label} · ${this.selected.id}${this.selected.online ? "" : " · offline"}`
      : "No session selected";
  }
  private select(session: SessionInfo) {
    this.element<HTMLInputElement>("delegate-task").checked = false;
    this.selected = session;
    this.conversation.clear();
    this.delivery.select(session.id);
    this.element("selected-session").textContent =
      `${session.label} · ${session.id}`;
    this.element<HTMLTextAreaElement>("message-input").placeholder =
      "Message this session…";
    this.controls();
    void this.refreshSurface();
  }
  private clearSurface() {
    this.surface.clearSurface();
    this.element("agent-controls").hidden = true;
  }
  private receive(event: Envelope, generation: number) {
    if (generation !== this.generation || event.sessionId !== this.selected?.id)
      return;
    if (event.type === "ui.render")
      this.delivery.receive(event.sessionId, event.payload.surface);
    else this.conversation.receive(event);
  }
  private async refreshSurface() {
    const client = this.client;
    const session = this.selected;
    if (client && session?.online)
      await this.delivery.refresh(() =>
        client.request("ui.get", { sessionId: session.id }),
      );
  }
  private async send() {
    const client = this.client;
    const session = this.selected;
    if (!client || !session?.online || this.sending) return;
    const input = this.element<HTMLTextAreaElement>("message-input");
    const text = input.value;
    if (!text.trim()) return;
    if (new TextEncoder().encode(text).length > 8192)
      throw new Error("The message must fit in 8 KiB.");
    input.value = "";
    await this.sendText(client, session, text);
  }
  private async sendText(
    client: HostClient,
    session: SessionInfo,
    text: string,
  ) {
    const generation = this.generation;
    const op = this.element<HTMLInputElement>("delegate-task").checked
      ? "tasks.delegate"
      : "sessions.chat";
    this.element<HTMLInputElement>("delegate-task").checked = false;
    this.conversation.add("You", text);
    this.sending = true;
    this.controls();
    try {
      await client.request(op, { sessionId: session.id, text });
    } catch (error) {
      if (generation === this.generation && session.id === this.selected?.id)
        throw error;
    } finally {
      if (generation === this.generation) {
        this.sending = false;
        this.controls();
      }
    }
  }
  private async createSession() {
    const client = this.client;
    const profileId = this.element<HTMLSelectElement>("session-profile").value;
    if (
      !client ||
      this.creating ||
      !this.profiles.some((profile) => profile.id === profileId)
    )
      return;
    const generation = this.generation;
    this.creating = true;
    this.controls();
    try {
      await client.request("sessions.create", {
        profileId,
        label: this.element<HTMLInputElement>("session-label").value,
      });
      await this.refreshSessions(client, generation);
      if (generation === this.generation)
        this.feedback("Session created. Select it from the list.");
    } catch {
      if (generation === this.generation)
        this.feedback(
          "Session creation failed. Check sessions:create access on the host.",
        );
    } finally {
      if (generation === this.generation) {
        this.creating = false;
        this.controls();
      }
    }
  }
  private async copy(id: string) {
    try {
      await this.deps.copy(this.element<HTMLTextAreaElement>(id).value);
      this.feedback("Agent instruction copied.");
    } catch {
      this.feedback("Copy failed. Select the text and copy it manually.");
    }
  }
  mountApprovedSurface(sessionId: string, surface: unknown) {
    if (!this.client || this.selected?.id !== sessionId)
      throw new Error("Select the surface's connected session first.");
    this.delivery.receive(sessionId, surface);
  }
  private renderSurface(sessionId: string, surface: unknown) {
    const generation = this.generation;
    const client = this.client!;
    this.surface.mountSurface(
      sessionId,
      surface,
      async (action: SurfaceAction) => {
        if (generation !== this.generation || this.selected?.id !== sessionId)
          throw new Error("The selected session changed.");
        await client.request("ui.action", action);
      },
    );
    this.element("agent-controls").hidden = false;
  }
  private reset() {
    this.generation += 1;
    const abort = this.connectionAbort;
    this.connectionAbort = null;
    abort?.abort();
    this.client = null;
    this.saveCandidate = null;
    this.selected = null;
    this.busy = false;
    this.sending = false;
    this.creating = false;
    this.refreshing = false;
    this.element<HTMLDetailsElement>("host-setup").open = true;
    this.setProfiles([]);
    this.element<HTMLInputElement>("session-label").value = "";
    this.element<HTMLDetailsElement>("create-session-panel").open = false;
    this.element<HTMLInputElement>("delegate-task").checked = false;
    this.delivery.select(null);
    this.element<HTMLInputElement>("pairing-code").value = "";
    this.element("host-id").textContent = "";
    this.element("host-label").textContent = "No host selected";
    this.element("selected-session").textContent = "No session selected";
    const item = document.createElement("li");
    item.textContent = "Connect to a host to see its registered sessions.";
    this.element("session-list").replaceChildren(item);
    this.status("Not connected");
    this.controls();
  }
  async disconnect() {
    const client = this.client;
    const attempt = this.attempt;
    this.reset();
    this.attempt = null;
    await Promise.all([client?.close(), attempt?.close()]);
  }
  async dispose() {
    this.listeners.forEach((remove) => remove());
    this.listeners = [];
    await this.disconnect();
  }
}

export function createBrowserApp(
  root: ParentNode,
  deps: BrowserDependencies,
  link: PairingLink = { kind: "none" },
) {
  return new BrowserApp(root, deps, link);
}
