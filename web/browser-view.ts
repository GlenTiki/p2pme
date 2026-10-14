import { z } from "zod";
import {
  sessionMetadataSchema,
  profileInfoSchema,
  type ProfileInfo,
  type SessionInfo,
} from "../src/host-protocol.js";
import type { Envelope } from "../src/protocol.js";

export function getElement<T extends HTMLElement>(
  root: ParentNode,
  id: string,
): T {
  const element = root.querySelector(`#${id}`);
  if (!(element instanceof HTMLElement))
    throw new Error(`Missing browser control: ${id}`);
  return element as T;
}

export function sessionList(input: unknown): SessionInfo[] {
  return z
    .strictObject({
      sessions: z
        .array(sessionMetadataSchema.extend({ online: z.boolean() }))
        .max(32),
    })
    .parse(input).sessions;
}

export function profileList(input: unknown): ProfileInfo[] {
  return z
    .strictObject({
      profiles: z
        .array(profileInfoSchema)
        .max(32)
        .refine(
          (profiles) =>
            new Set(profiles.map((profile) => profile.id)).size ===
            profiles.length,
        ),
    })
    .parse(input).profiles;
}

export function actionButton(label: string, handler: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

export function messageText(
  container: HTMLElement,
  role: string,
  text: string,
) {
  const block = document.createElement("div");
  block.className = "chat-message";
  const label = document.createElement("strong");
  label.textContent = role;
  const body = document.createElement("p");
  body.textContent = text;
  block.append(label, body);
  container.append(block);
  while (container.children.length > 200) container.firstElementChild?.remove();
  return body;
}

export function createConversation(container: HTMLElement) {
  const replies = new Map<string, HTMLParagraphElement>();
  return {
    clear() {
      replies.clear();
      container.replaceChildren();
    },
    add(role: string, text: string) {
      messageText(container, role, text);
    },
    receive(event: Envelope) {
      if (event.type !== "chat.delta" && event.type !== "chat.completed")
        return;
      if (!event.replyTo) return;
      let body = replies.get(event.replyTo);
      if (!body) {
        body = messageText(container, "Agent", "");
        replies.set(event.replyTo, body);
      }
      body.textContent =
        event.type === "chat.completed"
          ? event.payload.text
          : (body.textContent + event.payload.text).slice(-65536);
      if (replies.size > 200) replies.delete(replies.keys().next().value!);
    },
  };
}
