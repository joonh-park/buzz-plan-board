export const inject = ["react", "pages", "relay", "agents", "navigation", "conversation"];

const BOARD = "plans";
const CANVAS = 40100;
const MESSAGE = 9;
const MAX_CANVAS_BYTES = 256 * 1024;
const LOG_FAILED = "로그 게시 실패";
const STATES = {
  backlog: "예정",
  doing: "진행 중",
  review: "검토",
  blocked: "막힘",
  done: "완료",
};
const FIELDS = ["status", "owner", "project", "thread", "done-when", "blocker", "updated"];
const CARD_HEADER = /^## \[([a-zA-Z0-9][a-zA-Z0-9_-]{0,79})\] (.+?)\s*$/;
const CARD_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const HEX_ID = /^[0-9a-f]{64}$/i;
const FIELD = /^([-*+]) ([\w-]+):\s*(.*?)\s*$/;
const tag = (event, key) => event?.tags.find((parts) => parts[0] === key)?.[1];
const text = (error) => error?.message ?? String(error);

function today() {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseBoard(content) {
  const lines = content.split(/(?<=\n)/);
  const cards = new Map();
  let fence = "";
  let card;
  let fields = false;

  for (const [index, line] of lines.entries()) {
    const row = line.replace(/\r?\n$/, "");
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(row);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = "";
      }
      continue;
    }
    if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
      fence = marker[1];
      fields = false;
      continue;
    }
    const header = CARD_HEADER.exec(row);
    if (header) {
      const [, id, title] = header;
      if (cards.has(id)) throw new Error(`Duplicate board card ID: ${id}`);
      card = { id, title, index, values: {}, positions: new Map() };
      cards.set(id, card);
      fields = true;
      continue;
    }
    if (!fields) continue;
    // Canvas's editor separates headings from lists and can emit loose lists.
    if (!row.trim()) continue;
    const field = FIELD.exec(row);
    if (!field || (card.marker && field[1] !== card.marker)) {
      fields = false;
      continue;
    }
    const [, bullet, key, value] = field;
    card.firstField ??= index;
    card.marker = bullet;
    card.loose ||= card.lastField !== undefined && index > card.lastField + 1;
    card.lastField = index;
    if (!FIELDS.includes(key)) continue;
    if (card.positions.has(key)) throw new Error(`Duplicate ${key} field on card ${card.id}`);
    card.positions.set(key, index);
    card.values[key] = value;
  }
  return { lines, cards, fence };
}

function editBoard(content, { id, values: changes, title }) {
  const { lines, cards, fence } = parseBoard(content);
  const card = cards.get(id);
  const eol = content.match(/\r?\n/)?.[0] ?? "\n";
  const values = { ...changes, updated: today() };

  if (!card) {
    if (title === undefined) throw new Error(`Board card not found: ${id}`);
    if (fence) throw new Error("Close the unfinished code block in Canvas before adding a card.");
    const prefix = content || `# Plan board${eol}`;
    const end = prefix.endsWith(eol) ? eol : eol + eol;
    const metadata = FIELDS.filter((key) => values[key]).map((key) => `- ${key}: ${values[key]}`);
    return { content: `${prefix}${end}## [${id}] ${title}${eol}${metadata.join(eol)}${eol}` };
  }

  const oldTitle = lines[card.index];
  const headerEol = oldTitle.match(/\r?\n$/)?.[0] ?? eol;
  if (title !== undefined && title !== card.title) lines[card.index] = `## [${id}] ${title}${headerEol}`;
  const added = [];
  for (const key of FIELDS) {
    const value = values[key];
    if (value === undefined || value === card.values[key]) continue;
    const index = card.positions.get(key);
    if (index !== undefined) {
      const ending = lines[index].match(/\r?\n$/)?.[0] ?? "";
      lines[index] = value ? `${card.marker} ${key}: ${value}${ending}` : "";
    } else if (value) {
      added.push(`${card.marker ?? "-"} ${key}: ${value}${card.loose ? eol + eol : eol}`);
    }
  }
  if (added.length) {
    if (!lines[card.index].endsWith("\n")) lines[card.index] += headerEol;
    lines.splice(card.firstField ?? card.index + 1, 0, ...added);
  }
  return { content: lines.join(""), previous: card };
}

function oneLine(value, name, max = 240, optional = false) {
  if (optional && value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    /[\r\n\u0000-\u001f\u007f]/.test(value) ||
    value.length > max ||
    (!optional && !value.trim())
  ) {
    throw new Error(`${name} must be a single line of at most ${max} characters.`);
  }
  return value.trim();
}

function cardId(value) {
  const id = oneLine(value, "id", 80);
  if (!CARD_ID.test(id))
    throw new Error(
      "id must use letters, numbers, hyphens or underscores and start with a letter or number.",
    );
  return id;
}

function statusOf(value) {
  if (typeof value !== "string" || !Object.hasOwn(STATES, value))
    throw new Error("status must be backlog, doing, review, blocked or done.");
  return value;
}

const cardStatus = (values) => (Object.hasOwn(STATES, values.status) ? values.status : "backlog");

function threadLink(value) {
  if (typeof value !== "string" || /[<>\s]/.test(value) || !/^buzz:\/\/message\/?\?/i.test(value))
    return undefined;
  const url = new URL(value);
  const params = url.searchParams;
  const root = params.get("thread");
  const channel = params.get("channel") ?? "";
  const id = params.get("id") ?? "";
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(channel) ||
    !HEX_ID.test(id) ||
    (root !== null && !HEX_ID.test(root)) ||
    ["channel", "id", "thread"].some((key) => params.getAll(key).length > 1)
  )
    return undefined;
  return `buzz://message?${new URLSearchParams({ channel, id, ...(root ? { thread: root } : {}) })}`;
}

function upsertInput(args) {
  const thread = threadLink(oneLine(args.thread, "thread", 500));
  if (!thread) throw new Error("thread must be a Buzz message or thread link.");
  const status = statusOf(args.status);
  return {
    id: args.id === undefined ? crypto.randomUUID() : cardId(args.id),
    title: oneLine(args.title, "title"),
    values: {
      status,
      owner: oneLine(args.owner, "owner", 100),
      project: oneLine(args.project, "project", 100),
      thread,
      "done-when": oneLine(args.done_when, "done_when", 500),
      blocker: blockerFor(args.blocker, status),
    },
  };
}

function blockerFor(value, status) {
  return oneLine(value, "blocker", 500, true) ?? (status === "blocked" ? undefined : "");
}

function moveInput(args) {
  const status = statusOf(args.status);
  return {
    id: cardId(args.id),
    values: { status, blocker: blockerFor(args.blocker, status) },
  };
}

function findBoard(channels) {
  const named = channels.filter(
    (channel) => channel.name === BOARD && channel.type === "stream" && !channel.archived,
  );
  if (named.length > 1)
    throw new Error("More than one joined #plans channel exists. Keep one active board channel.");
  if (!named[0]) throw new Error("Join the #plans stream channel to open the board.");
  return named[0];
}

async function agentBoard(client) {
  const ids = new Set();
  let cursor = {};
  for (;;) {
    client.signal?.throwIfAborted();
    const page = await client.query([{ kinds: [39002], "#p": [client.pubkey], limit: 100, ...cursor }]);
    for (const row of page) {
      if (
        row.kind !== 39002 ||
        !row.tags.some((parts) => parts[0] === "p" && parts[1] === client.pubkey)
      )
        continue;
      const id = tag(row, "d");
      if (id) ids.add(id);
    }
    if (page.length < 100) break;
    const last = page.at(-1);
    if (cursor.before_id === last.id || ids.size >= 5000)
      throw new Error("Could not resolve #plans from the channel roster.");
    cursor = { until: last.created_at, before_id: last.id };
  }

  const channels = [];
  const joined = [...ids];
  for (let index = 0; index < joined.length; index += 100) {
    client.signal?.throwIfAborted();
    const batch = joined.slice(index, index + 100);
    const rows = await client.query([{ kinds: [39000], "#d": batch, limit: batch.length }]);
    for (const row of rows) {
      const id = tag(row, "d");
      if (row.kind !== 39000 || !batch.includes(id)) continue;
      const kinds = row.tags.flatMap(([key, value]) => (key === "t" ? [value] : []));
      const [type = "stream", ...labels] = kinds;
      if (
        type === "stream" &&
        (labels.includes("buzz.solo") ||
          row.tags.some(
            ([key, value, namespace]) => key === "l" && value === "solo" && namespace === "buzz.channel",
          ))
      )
        continue;
      channels.push({
        id,
        name: tag(row, "name"),
        type,
        archived: row.tags.some((parts) => parts[0] === "archived"),
      });
    }
  }
  return findBoard([...new Map(channels.map((channel) => [channel.id, channel])).values()]).id;
}

async function agentCanvas(client) {
  const channel = await agentBoard(client);
  return {
    signal: client.signal,
    read: async () => {
      const [head] = await client.query([
        { kinds: [CANVAS], "#h": [channel], limit: 1, consistency: "strong" },
      ]);
      if (head) {
        const scope = head.tags.filter((parts) => parts[0] === "h");
        if (
          head.kind !== CANVAS ||
          scope.length !== 1 ||
          scope[0].length !== 2 ||
          scope[0][1] !== channel
        ) {
          throw new Error("The relay returned a Canvas outside #plans.");
        }
      }
      return head;
    },
    save: (content, expected) =>
      client.publish({
        kind: CANVAS,
        content,
        tags: [
          ["h", channel],
          ["expected-revision", expected ?? "none"],
          ["canvas-instructions", "unapproved"],
        ],
      }),
    postLog: (content) => client.publish({ kind: MESSAGE, content, tags: [["h", channel]] }),
  };
}

function pause(delay, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delay);
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function waitForRevision(head, signal) {
  const after = head ? (head.created_at + 1) * 1000 : 0;
  for (;;) {
    signal?.throwIfAborted();
    const delay = after - Date.now();
    if (delay <= 0) return;
    if (delay > 5000)
      throw new Error("Canvas timestamp is ahead of this device. Try again after checking its clock.");
    await pause(delay, signal);
  }
}

const isConflict = (error) =>
  error?.name === "CanvasConflictError" ||
  /\bconflict:|Please wait a second before saving Canvas again|a different Canvas is selected/i.test(
    text(error),
  );

function cardLog(previous, { id, title, values }) {
  const status = cardStatus(values);
  const from = previous && cardStatus(previous.values);
  if (from === status) return;
  const transition = from ? `${from} → ${status}` : `새 카드 · ${status}`;
  const parts = [`[${id}] ${title}`, transition, values.owner || "담당 미지정"];
  if (status === "blocked") parts.push(`막힘: ${values.blocker || "사유 미기재"}`);
  return parts.join(" · ").replace(/[\r\n\u0085\u2028\u2029]+/g, " ");
}

async function writeCard(store, change) {
  for (let attempt = 0; attempt < 2; attempt++) {
    store.signal?.throwIfAborted();
    const head = await store.read();
    const before = head?.content ?? "";
    const { content, previous } = editBoard(before, change);
    if (content === before) return { head, changed: false };
    if (new TextEncoder().encode(content).length > MAX_CANVAS_BYTES)
      throw new Error("Canvas exceeds 256 KiB.");
    await waitForRevision(head, store.signal);
    store.signal?.throwIfAborted();
    let saved;
    try {
      saved = await store.save(content, head?.id);
    } catch (error) {
      if (attempt === 0 && isConflict(error)) continue;
      throw error;
    }
    const confirmed = await store.read();
    if (confirmed?.id === saved?.id && confirmed?.content === content) {
      try {
        const log = cardLog(previous, parseBoard(confirmed.content).cards.get(change.id));
        if (log) await store.postLog(log);
      } catch {
        return { head: confirmed, changed: true, warning: LOG_FAILED };
      }
      return { head: confirmed, changed: true };
    }
    // Only retry if another selected revision is visible. Report uncertain read-back as an error.
    if (attempt === 0 && confirmed?.id && confirmed.id !== head?.id && confirmed.id !== saved?.id)
      continue;
    throw new Error("Canvas save could not be verified. Refresh the board before retrying.");
  }
  throw new Error("Canvas changed while saving. Refresh the board and try again.");
}

async function projectPointer(client, channel) {
  if (!channel) return "";
  const [metadata] = await client.query([{ kinds: [39000], "#d": [channel], limit: 1 }]);
  if (metadata?.kind !== 39000 || tag(metadata, "d") !== channel) return "";
  const pointer = ["purpose", "about", "topic"]
    .map((key) => tag(metadata, key)?.split(/\r?\n/, 1)[0]?.trim())
    .find(Boolean);
  return pointer ? `#${tag(metadata, "name") ?? channel} · ${pointer.slice(0, 350)}` : "";
}

const string = { type: "string" };
const stateSchema = { type: "string", enum: Object.keys(STATES) };
const schema = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

function registerTools(agents, write) {
  agents.addTool({
    name: "board_list",
    description:
      "List plan board cards in #plans, excluding done unless requested. Includes the current channel's project pointer.",
    inputSchema: schema({ status: stateSchema, owner: string, project: string }),
    async call(client, context, args) {
      const status = args.status === undefined ? undefined : statusOf(args.status);
      const owner = oneLine(args.owner, "owner", 100, true);
      const project = oneLine(args.project, "project", 100, true);
      const store = await agentCanvas(client);
      const [head, pointer] = await Promise.all([store.read(), projectPointer(client, context.channel)]);
      const { cards } = parseBoard(head?.content ?? "");
      const filtered = [...cards.values()].filter(
        ({ values }) =>
          (status ? cardStatus(values) === status : cardStatus(values) !== "done") &&
          (!owner || values.owner?.toLowerCase() === owner.toLowerCase()) &&
          (!project || values.project?.toLowerCase() === project.toLowerCase()),
      );
      const rows = filtered
        .slice(0, 40)
        .map(({ id, title, values }) =>
          [
            `[${id}] ${title}`,
            [cardStatus(values), values.owner, values.project].filter(Boolean).join(" / "),
            values["done-when"],
            values.blocker && `막힘: ${values.blocker}`,
            values.thread,
          ]
            .filter(Boolean)
            .join(" · "),
        );
      if (filtered.length > rows.length)
        rows.push(
          `${filtered.length - rows.length}개 더 있음. owner, project 또는 status로 좁혀 주세요.`,
        );
      return [pointer, rows.join("\n") || "일치하는 카드가 없습니다."].filter(Boolean).join("\n\n");
    },
  });
  agents.addTool({
    name: "board_upsert",
    description: "Add or update a plan board card in #plans. Use its existing ID to update it.",
    inputSchema: schema(
      {
        id: string,
        title: string,
        status: stateSchema,
        owner: string,
        project: string,
        thread: string,
        done_when: string,
        blocker: string,
      },
      ["title", "status", "owner", "project", "thread", "done_when"],
    ),
    async call(client, _context, args) {
      const change = upsertInput(args);
      const result = await write(() => agentCanvas(client), change);
      const saved = `[${change.id}] ${result.changed ? "저장" : "변경 없음"} · ${change.values.status}`;
      return result.warning ? `${saved} · ${result.warning}` : saved;
    },
  });
  agents.addTool({
    name: "board_move",
    description: "Move a plan board card to a different status in #plans.",
    inputSchema: schema({ id: string, status: stateSchema, blocker: string }, ["id", "status"]),
    async call(client, _context, args) {
      const change = moveInput(args);
      const result = await write(() => agentCanvas(client), change);
      const saved = `[${change.id}] ${change.values.status} · ${result.changed ? "저장" : "변경 없음"}`;
      return result.warning ? `${saved} · ${result.warning}` : saved;
    },
  });
}

const BOARD_CSS = `
.pb-root {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: var(--space-panel-inset, 18px);
  box-sizing: border-box;
  color: var(--text-standard, inherit);
}
.pb-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-standard, rgba(127, 127, 127, 0.22));
}
.pb-title-group {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.pb-title {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-standard, inherit);
}
.pb-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 500;
  background: var(--surface-inset, rgba(127, 127, 127, 0.12));
  color: var(--text-subtle, inherit);
  border: 1px solid var(--border-standard, rgba(127, 127, 127, 0.2));
}
.pb-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.pb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 14px;
  border-radius: var(--radius-control, 8px);
  border: 1px solid var(--border-prominent, rgba(127, 127, 127, 0.35));
  background: var(--surface-panel, transparent);
  color: var(--text-standard, inherit);
  font-family: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
.pb-btn:hover:not(:disabled) {
  background: var(--surface-inset, rgba(127, 127, 127, 0.12));
}
.pb-btn:focus-visible {
  outline: 2px solid var(--border-focus, currentColor);
  outline-offset: 2px;
}
.pb-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pb-btn-primary {
  background: var(--affordance-prominent, var(--surface-inverse, #1f2937));
  color: var(--text-on-prominent, var(--text-inverse, #ffffff));
  border-color: transparent;
}
.pb-btn-primary:hover:not(:disabled) {
  opacity: 0.9;
  background: var(--affordance-prominent, var(--surface-inverse, #1f2937));
}
.pb-form-panel {
  background: var(--surface-panel, transparent);
  border: 1px solid var(--border-prominent, rgba(127, 127, 127, 0.35));
  border-radius: 12px;
  padding: 18px 20px;
  box-shadow: var(--shadow-sm, 0 4px 12px rgba(0, 0, 0, 0.08));
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 58rem;
}
.pb-form-head {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-standard, rgba(127, 127, 127, 0.2));
}
.pb-form-title {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--text-standard, inherit);
}
.pb-form-sub {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--text-metadata, var(--text-subtle, inherit));
}
.pb-form-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 14px 12px;
}
.pb-span-6 { grid-column: span 6; }
.pb-span-3 { grid-column: span 3; }
.pb-span-2 { grid-column: span 2; }
@media (max-width: 720px) {
  .pb-span-3, .pb-span-2 { grid-column: span 6; }
}
.pb-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.pb-label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-standard, inherit);
  line-height: 1.3;
}
.pb-input,
.pb-select {
  width: 100%;
  min-width: 0;
  height: 36px;
  padding: 0 11px;
  box-sizing: border-box;
  border-radius: var(--radius-control, 8px);
  border: 1px solid var(--border-prominent, rgba(127, 127, 127, 0.38));
  background: var(--surface-inset, rgba(127, 127, 127, 0.08));
  color: var(--text-standard, inherit);
  font-family: inherit;
  font-size: 0.875rem;
  line-height: 1.4;
  transition: border-color 120ms ease, box-shadow 120ms ease, background-color 120ms ease;
}
.pb-input-mono {
  font-family: var(--font-system-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 0.8125rem;
}
.pb-input::placeholder {
  color: var(--text-metadata, rgba(127, 127, 127, 0.75));
}
.pb-input:focus,
.pb-select:focus {
  outline: none;
  border-color: var(--border-focus, currentColor);
  background: var(--surface-panel, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--border-focus, currentColor) 18%, transparent);
}
.pb-input:disabled,
.pb-select:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.pb-form-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--border-standard, rgba(127, 127, 127, 0.2));
}
.pb-alert {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-danger, rgba(220, 38, 38, 0.45));
  background: color-mix(in srgb, var(--border-danger, #dc2626) 10%, transparent);
  color: var(--text-danger, inherit);
  font-size: 0.875rem;
}
.pb-status-note {
  font-size: 0.8125rem;
  color: var(--text-metadata, inherit);
}
.pb-columns {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  overflow-y: hidden;
  min-height: 0;
  flex: 1;
  padding-bottom: 4px;
}
.pb-column {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1 0 15.5rem;
  min-width: 15.5rem;
  min-height: 0;
  padding: 12px;
  border-radius: 12px;
  background: var(--surface-inset, rgba(127, 127, 127, 0.06));
  border: 1px solid var(--border-standard, rgba(127, 127, 127, 0.18));
  box-sizing: border-box;
}
.pb-col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 2px 6px;
  border-bottom: 1px solid var(--border-standard, rgba(127, 127, 127, 0.16));
}
.pb-col-title-wrap {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.pb-col-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex-shrink: 0;
}
.pb-col-title {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-standard, inherit);
}
.pb-col-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
}
.pb-col-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  min-height: 0;
  flex: 1;
  padding-right: 2px;
}
.pb-empty {
  padding: 18px 12px;
  border-radius: 8px;
  border: 1px dashed var(--border-standard, rgba(127, 127, 127, 0.25));
  text-align: center;
  font-size: 0.8125rem;
  color: var(--text-metadata, inherit);
}
.pb-card {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px;
  border-radius: 10px;
  background: var(--surface-panel, transparent);
  border: 1px solid var(--border-standard, rgba(127, 127, 127, 0.22));
  box-shadow: var(--shadow-xs, 0 1px 2px rgba(0, 0, 0, 0.05));
  overflow-wrap: anywhere;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.pb-card:hover {
  border-color: var(--border-prominent, rgba(127, 127, 127, 0.42));
}
.pb-card-blocked {
  border-left: 3px solid var(--border-danger, #dc2626);
}
.pb-card-title {
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1.38;
  color: var(--text-standard, inherit);
}
.pb-card-title p {
  margin: 0;
}
.pb-card-title a {
  color: var(--text-standard, inherit);
  text-decoration: none;
}
.pb-card-title a:hover {
  text-decoration: underline;
}
.pb-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.pb-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 500;
  background: var(--surface-inset, rgba(127, 127, 127, 0.12));
  color: var(--text-subtle, inherit);
}
.pb-done-when {
  font-size: 0.8125rem;
  line-height: 1.45;
  color: var(--text-subtle, inherit);
}
.pb-blocker {
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 0.8125rem;
  line-height: 1.4;
  background: var(--surface-categorical-amber, rgba(245, 158, 11, 0.14));
  color: var(--text-categorical-amber, var(--text-danger, inherit));
}
.pb-card-footer {
  padding-top: 8px;
  border-top: 1px solid var(--border-standard, rgba(127, 127, 127, 0.16));
}
.pb-card-select {
  height: 30px;
  font-size: 0.8125rem;
  padding: 0 8px;
}
`;

const STATE_TONES = {
  backlog: {
    dot: "var(--text-metadata, #6b7280)",
    bg: "var(--surface-panel, rgba(127, 127, 127, 0.14))",
    fg: "var(--text-subtle, inherit)",
  },
  doing: {
    dot: "var(--text-categorical-blue, #2563eb)",
    bg: "var(--surface-categorical-blue, rgba(37, 99, 235, 0.14))",
    fg: "var(--text-categorical-blue, inherit)",
  },
  review: {
    dot: "var(--text-categorical-purple, #7c3aed)",
    bg: "var(--surface-categorical-purple, rgba(124, 58, 237, 0.14))",
    fg: "var(--text-categorical-purple, inherit)",
  },
  blocked: {
    dot: "var(--border-danger, #dc2626)",
    bg: "var(--surface-categorical-amber, rgba(245, 158, 11, 0.16))",
    fg: "var(--text-categorical-amber, inherit)",
  },
  done: {
    dot: "var(--text-success, #16a34a)",
    bg: "var(--surface-categorical-green, rgba(22, 163, 74, 0.14))",
    fg: "var(--text-categorical-green, inherit)",
  },
};

function canvasForPage(relay, session, channel) {
  const check = () => {
    const current = relay.snapshot();
    const joined = session.channels.list().channels;
    if (
      current.status !== "ready" ||
      current.session !== session ||
      !joined.some(
        (item) => item.id === channel && item.name === BOARD && !item.archived && !item.cached,
      )
    ) {
      throw new Error("#plans 접근 상태가 바뀌었습니다. 보드를 새로고침해 주세요.");
    }
  };
  return {
    read() {
      check();
      return session.canvas.read(channel, { strong: true });
    },
    save(content, expected) {
      check();
      return session.canvas.save(channel, content, expected, { preserveApproval: true });
    },
    async postLog(content) {
      const active = () => {
        const current = relay.snapshot();
        return current.status === "ready" && current.session === session;
      };
      check();
      const id = session.outbox.send({ kind: MESSAGE, content, tags: [["h", channel]] });
      await session.channelWrites.delivered(id, active, false, false);
    },
  };
}

function createPage(ctx, write, watch) {
  const { react: React, relay, conversation } = ctx;
  const h = React.createElement;
  const Markdown = conversation.ui.Markdown;
  const relaySnapshot = () => relay.snapshot();
  const subscribeRelay = (listener) => relay.subscribe(listener);
  const choices = Object.entries(STATES).map(([key, label]) => h("option", { key, value: key }, label));

  function BoardCard({ card, session, disabled, move }) {
    const { id, title, values } = card;
    const url = threadLink(values.thread);
    const status = cardStatus(values);
    return h(
      "article",
      { className: `ui-card pb-card${status === "blocked" ? " pb-card-blocked" : ""}` },
      h(
        "div",
        { className: "pb-card-title" },
        url
          ? h(Markdown, {
              session,
              content: `[${title.replace(/[\\\[\]`*_<>!]/g, (char) => `\\${char}`)}](<${url}>)`,
            })
          : h("strong", null, title),
      ),
      (values.owner || values.project) &&
        h(
          "div",
          { className: "pb-chips" },
          values.owner && h("span", { className: "pb-chip" }, values.owner),
          values.project && h("span", { className: "pb-chip" }, values.project),
        ),
      values["done-when"] && h("div", { className: "pb-done-when" }, values["done-when"]),
      values.blocker && h("div", { className: "pb-blocker" }, `막힘 · ${values.blocker}`),
      h(
        "div",
        { className: "pb-card-footer" },
        h(
          "select",
          {
            className: "pb-select pb-card-select",
            "aria-label": `${title} 상태`,
            disabled,
            value: status,
            onChange: (event) => move(id, event.target.value),
          },
          choices,
        ),
      ),
    );
  }

  function AddCard({ add, pending, close }) {
    const field = (name, label, { maxLength, placeholder, required = true, span = "pb-span-6", mono = false }) => {
      const id = `pb-add-${name}`;
      return h(
        "div",
        { key: name, className: `pb-field ${span}` },
        h("label", { htmlFor: id, className: "pb-label" }, label),
        h("input", {
          id,
          name,
          className: `pb-input${mono ? " pb-input-mono" : ""}`,
          maxLength,
          placeholder,
          required,
          disabled: pending,
        }),
      );
    };
    return h(
      "form",
      {
        className: "ui-card pb-form-panel",
        onSubmit: (event) => {
          event.preventDefault();
          add(Object.fromEntries(new FormData(event.currentTarget)));
        },
      },
      h(
        "div",
        { className: "pb-form-head" },
        h("h2", { className: "pb-form-title" }, "새 카드 추가"),
        h("p", { className: "pb-form-sub" }, "각 항목 아래 입력 칸에 내용을 적은 뒤 카드 저장을 눌러 주세요."),
      ),
      h(
        "div",
        { className: "pb-form-grid" },
        field("title", "제목", { maxLength: 240, placeholder: "예: 계획 보드 UI 개선", span: "pb-span-6" }),
        field("owner", "담당", { maxLength: 100, placeholder: "예: Neon", span: "pb-span-2" }),
        field("project", "프로젝트", { maxLength: 100, placeholder: "예: buzz", span: "pb-span-2" }),
        h(
          "div",
          { className: "pb-field pb-span-2" },
          h("label", { htmlFor: "pb-add-status", className: "pb-label" }, "상태"),
          h(
            "select",
            {
              id: "pb-add-status",
              name: "status",
              className: "pb-select",
              defaultValue: "backlog",
              disabled: pending,
            },
            choices,
          ),
        ),
        field("thread", "Buzz 스레드 링크", {
          maxLength: 500,
          placeholder: "buzz://message?channel=...&id=...",
          span: "pb-span-6",
          mono: true,
        }),
        field("done_when", "완료 조건", {
          maxLength: 500,
          placeholder: "예: 데스크톱 화면 확인 및 테스트 통과",
          span: "pb-span-3",
        }),
        field("blocker", "막힌 이유 (선택)", {
          maxLength: 500,
          placeholder: "막힘 상태일 때만 입력",
          required: false,
          span: "pb-span-3",
        }),
      ),
      h(
        "div",
        { className: "pb-form-footer" },
        h("button", { type: "button", className: "pb-btn", disabled: pending, onClick: close }, "취소"),
        h("button", { type: "submit", className: "pb-btn pb-btn-primary", disabled: pending }, "카드 저장"),
      ),
    );
  }

  function ConnectedBoard({ session }) {
    const channels = session.channels;
    const list = React.useSyncExternalStore(
      React.useCallback((listener) => channels.subscribeList(listener), [channels]),
      React.useCallback(() => channels.list(), [channels]),
    );
    React.useEffect(() => {
      channels.ensureList();
    }, [channels]);
    if (list.status === "error") {
      return h(
        "div",
        { className: "pb-root" },
        h("style", null, BOARD_CSS),
        h("p", { role: "alert", className: "pb-alert" }, "채널 목록을 읽지 못했습니다."),
        h("div", null, h("button", { className: "pb-btn", onClick: () => channels.refreshList?.() }, "다시 시도")),
      );
    }
    if (list.status !== "ready")
      return h(
        "div",
        { className: "pb-root" },
        h("style", null, BOARD_CSS),
        h("p", { role: "status", className: "pb-status-note" }, "채널을 불러오는 중…"),
      );
    let joined;
    try {
      joined = findBoard(
        list.channels
          .filter((item) => !item.cached && !item.pending)
          .map((item) => ({
            ...item,
            type: item.channelType ?? "stream",
          })),
      );
    } catch (error) {
      return h(
        "div",
        { className: "pb-root" },
        h("style", null, BOARD_CSS),
        h("p", { role: "status", className: "pb-status-note" }, text(error)),
      );
    }
    return h(CanvasBoard, { key: joined.id, session, channel: joined.id, readOnly: !!joined.readOnly });
  }

  function CanvasBoard({ session, channel, readOnly }) {
    const store = React.useMemo(() => canvasForPage(relay, session, channel), [session, channel]);
    const [revision, refresh] = React.useReducer((count) => count + 1, 0);
    const [state, setState] = React.useState({ loading: true, cards: [] });
    const [operation, setOperation] = React.useState({ pending: false, error: "" });
    const [adding, setAdding] = React.useState(false);
    const submitting = React.useRef(false);

    React.useEffect(() => watch(refresh), [refresh]);
    React.useEffect(() => {
      window.addEventListener("focus", refresh);
      return () => window.removeEventListener("focus", refresh);
    }, [refresh]);
    React.useEffect(() => {
      let current = true;
      setState((before) => ({ ...before, loading: true, error: "" }));
      Promise.resolve()
        .then(store.read)
        .then((head) => {
          const { cards } = parseBoard(head?.content ?? "");
          if (current) setState({ loading: false, cards: [...cards.values()] });
        })
        .catch((error) => {
          if (current) setState({ loading: false, cards: [], error: text(error) });
        });
      return () => {
        current = false;
      };
    }, [store, revision]);

    async function submit(buildChange, args, onSaved) {
      if (submitting.current) return;
      submitting.current = true;
      setOperation({ pending: true, error: "" });
      try {
        const result = await write(() => store, buildChange(args));
        onSaved?.();
        setOperation({ pending: false, error: result.warning ? `카드 저장 완료 · ${result.warning}` : "" });
      } catch (error) {
        setOperation({ pending: false, error: text(error) });
      } finally {
        submitting.current = false;
      }
    }

    const disabled =
      operation.pending || state.loading || readOnly || !!state.error || !session.canvas.available;
    const activeCount = state.cards.filter(({ values }) => cardStatus(values) !== "done").length;
    return h(
      "section",
      { "aria-label": "계획 보드", className: "pb-root" },
      h("style", null, BOARD_CSS),
      h(
        "header",
        { className: "pb-header" },
        h(
          "div",
          { className: "pb-title-group" },
          h("h1", { className: "pb-title" }, "계획 보드"),
          h("span", { className: "pb-badge" }, "#plans"),
          !state.loading &&
            !state.error &&
            h("span", { className: "pb-badge" }, `진행 ${activeCount} · 전체 ${state.cards.length}`),
          (readOnly || !session.canvas.available) && h("span", { className: "pb-badge" }, "읽기 전용"),
        ),
        h(
          "div",
          { className: "pb-actions" },
          h(
            "button",
            {
              className: "pb-btn",
              disabled: state.loading || operation.pending,
              onClick: refresh,
            },
            "새로고침",
          ),
          h(
            "button",
            {
              className: `pb-btn${adding ? "" : " pb-btn-primary"}`,
              disabled,
              "aria-expanded": adding,
              onClick: () => setAdding(!adding),
            },
            "카드 추가",
          ),
        ),
      ),
      adding &&
        h(AddCard, {
          pending: disabled,
          close: () => setAdding(false),
          add: (args) => submit(upsertInput, args, () => setAdding(false)),
        }),
      state.loading && h("span", { role: "status", className: "pb-status-note" }, "보드를 불러오는 중…"),
      (state.error || operation.error) &&
        h("p", { role: "alert", className: "pb-alert" }, operation.error || state.error),
      !state.error &&
        (!state.loading || state.cards.length > 0) &&
        h(
          "div",
          { className: "pb-columns" },
          Object.entries(STATES).map(([status, label]) => {
            const group = state.cards.filter(({ values }) => cardStatus(values) === status);
            const tone = STATE_TONES[status];
            return h(
              "section",
              { key: status, "aria-label": label, className: "pb-column" },
              h(
                "div",
                { className: "pb-col-head" },
                h(
                  "div",
                  { className: "pb-col-title-wrap" },
                  h("span", { className: "pb-col-dot", style: { background: tone.dot } }),
                  h("h2", { className: "pb-col-title" }, label),
                ),
                h(
                  "span",
                  { className: "pb-col-count", style: { background: tone.bg, color: tone.fg } },
                  String(group.length),
                ),
              ),
              h(
                "div",
                { className: "pb-col-list" },
                group.map((card) =>
                  h(BoardCard, {
                    key: card.id,
                    card,
                    session,
                    disabled,
                    move: (id, status) => submit(moveInput, { id, status }),
                  }),
                ),
                group.length === 0 && h("div", { className: "pb-empty" }, "카드 없음"),
              ),
            );
          }),
        ),
    );
  }

  return function PlanBoard() {
    const snapshot = React.useSyncExternalStore(subscribeRelay, relaySnapshot);
    if (snapshot.status !== "ready")
      return h(
        "div",
        { className: "pb-root" },
        h("style", null, BOARD_CSS),
        h("p", { role: "status", className: "pb-status-note" }, "커뮤니티 연결 후 보드를 열 수 있습니다."),
      );
    return h(ConnectedBoard, { key: snapshot.generation, session: snapshot.session });
  };
}

export function apply(ctx) {
  let queue = Promise.resolve();
  const listeners = new Set();
  const write = (open, change) => {
    const result = queue.then(async () => writeCard(await open(), change));
    queue = result.catch(() => {});
    return result.then((updated) => {
      if (updated.changed) for (const listener of listeners) listener();
      return updated;
    });
  };
  const watch = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  registerTools(ctx.agents, write);
  ctx.agents.addInstructions({
    id: "plan-board",
    text: "작업을 맡거나 끝내면 board_move로 #plans 보드 카드를 갱신(도구: board_list, board_upsert, board_move — 안 보이면 tool search).",
  });
  ctx.pages.register({
    id: "board",
    title: "계획 보드",
    primary: true,
    layout: "workspace",
    component: createPage(ctx, write, watch),
  });
}
