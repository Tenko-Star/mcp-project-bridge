import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { parseGitRemote } from "./remoteKey.js";
import type {
  DocumentFormat,
  MessageSearchResult,
  MessageVersion,
  ProjectDevice,
  ProjectRegistration,
  RegisteredProject,
  UnreadMessage
} from "./types.js";

const MESSAGE_SCHEMA_VERSION = "remote-message-v1";
const supportedFormats = new Set<DocumentFormat>(["markdown", "text", "json"]);

type StoreOptions = {
  dbPath: string;
};

type RegisterProjectInput = {
  remote: string;
  deviceId?: string;
  projectDescription?: string;
  deviceDescription?: string;
};

type ListProjectsInput = {
  query?: string;
  limit?: number;
};

type UpsertMessageInput = {
  currentProjectRemote: string;
  messageId?: number;
  targetProjectRemote?: string | null;
  docKey: string;
  title?: string;
  content: string;
  format?: DocumentFormat;
  tags?: string[];
};

type ReadUnreadMessagesInput = {
  currentProjectRemote: string;
  deviceId: string;
  withBroadcast?: boolean;
  limit?: number;
};

type ListMessagesInput = {
  currentProjectRemote: string;
  deviceId: string;
  withBroadcast?: boolean;
  query?: string;
  tags?: string[];
  limit?: number;
};

type GetMessageHistoryInput = {
  currentProjectRemote: string;
  messageId: number;
  withBroadcast?: boolean;
  limit?: number;
};

type ProjectRow = {
  key: string;
  remote: string;
  project_description: string | null;
  created_at: string;
};

type ProjectDeviceRow = {
  project_key: string;
  device_id: string;
  device_description: string | null;
  created_at: string;
  last_seen_at: string;
};

type MessageRow = {
  id: number;
  sender_project_key: string;
  target_project_key: string | null;
  doc_key: string;
  title: string | null;
  format: DocumentFormat;
  tags_json: string;
  created_at: string;
  updated_at: string;
};

type MessageVersionRow = {
  message_id: number;
  version_id: number;
  sender_project_key: string;
  target_project_key: string | null;
  doc_key: string;
  title: string | null;
  format: DocumentFormat;
  tags_json: string;
  version: number;
  content: string;
  author_project_key: string;
  created_at: string;
};

type MessageSearchRow = MessageVersionRow & {
  read_at: string | null;
};

type SchemaVersionRow = {
  value: string;
};

type VersionRow = {
  next_version: number;
};

export class ProjectBridgeStore {
  private readonly db: Database.Database;

  constructor(options: StoreOptions) {
    if (options.dbPath !== ":memory:") {
      mkdirSync(path.dirname(options.dbPath), { recursive: true });
    }

    this.db = new Database(options.dbPath);
    this.configureDatabase();
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  registerProject(input: RegisterProjectInput): ProjectRegistration {
    const parsedRemote = parseGitRemote(input.remote);
    const deviceId = normalizeOptionalString(input.deviceId);
    const projectDescription = normalizeOptionalString(input.projectDescription) ?? null;
    const deviceDescription = normalizeOptionalString(input.deviceDescription) ?? null;

    const register = this.db.transaction(() => {
      const now = new Date().toISOString();
      const existingProject = this.getProjectRow(parsedRemote.key);

      if (!existingProject) {
        this.db.prepare(`
          INSERT INTO projects (key, remote, project_description, created_at)
          VALUES (@key, @remote, @projectDescription, @createdAt)
        `).run({
          key: parsedRemote.key,
          remote: parsedRemote.remote,
          projectDescription,
          createdAt: now
        });
      }

      let device: ProjectDevice | undefined;
      if (deviceId) {
        this.db.prepare(`
          INSERT INTO project_devices (
            project_key,
            device_id,
            device_description,
            created_at,
            last_seen_at
          )
          VALUES (
            @projectKey,
            @deviceId,
            @deviceDescription,
            @createdAt,
            @lastSeenAt
          )
          ON CONFLICT(project_key, device_id) DO UPDATE SET
            device_description = CASE
              WHEN excluded.device_description IS NULL THEN project_devices.device_description
              ELSE excluded.device_description
            END,
            last_seen_at = excluded.last_seen_at
        `).run({
          projectKey: parsedRemote.key,
          deviceId,
          deviceDescription,
          createdAt: now,
          lastSeenAt: now
        });

        device = mapProjectDeviceRow(this.getDeviceRowOrThrow(parsedRemote.key, deviceId));
      }

      return {
        ...this.getRegisteredProject(parsedRemote.key),
        ...(device ? { device } : {})
      };
    });

    return register();
  }

  listProjects(input: ListProjectsInput = {}): RegisteredProject[] {
    const query = normalizeOptionalString(input.query);
    const limit = normalizeOptionalLimit(input.limit);
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (query) {
      conditions.push("(key LIKE @query OR remote LIKE @query OR COALESCE(project_description, '') LIKE @query)");
      params.query = `%${query}%`;
    }

    const limitClause = appendOptionalLimit(params, limit);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT key, remote, project_description, created_at
      FROM projects
      ${whereClause}
      ORDER BY key ASC
      ${limitClause}
    `).all(params) as ProjectRow[];

    return rows.map((row) => mapProjectRow(row, this.listDevicesForProject(row.key)));
  }

  upsertMessage(input: UpsertMessageInput): MessageVersion {
    const currentProjectKey = parseGitRemote(input.currentProjectRemote).key;
    const messageId = normalizeOptionalPositiveInteger(input.messageId, "Message id must be a positive integer.");
    const targetRemote = normalizeOptionalString(input.targetProjectRemote);
    const targetProjectKey = targetRemote ? parseGitRemote(targetRemote).key : undefined;
    const targetProvided = Object.prototype.hasOwnProperty.call(input, "targetProjectRemote");
    const docKey = normalizeRequiredKey(input.docKey, "Document key is required.");
    const content = normalizeRequiredString(input.content, "Message content is required.");
    const format = input.format;

    if (format !== undefined && !supportedFormats.has(format)) {
      throw new Error(`Unsupported document format: ${format}.`);
    }

    const saveMessage = this.db.transaction(() => {
      this.ensureProjectRegistered(currentProjectKey, "Current project");
      if (targetProjectKey) {
        this.ensureProjectRegistered(targetProjectKey, "Target project");
      }

      const now = new Date().toISOString();
      const tagsJson = input.tags === undefined ? null : JSON.stringify(normalizeStringArray(input.tags));
      let resolvedMessageId: number;

      if (messageId !== undefined) {
        const existing = this.getMessageRowOrThrow(messageId);
        if (existing.sender_project_key !== currentProjectKey) {
          throw new Error(`Only the sender project can update message: ${messageId}.`);
        }
        if (targetProvided && targetProjectKey !== (existing.target_project_key ?? undefined)) {
          throw new Error("Message target cannot be changed; create a new message.");
        }

        this.db.prepare(`
          UPDATE messages
          SET
            doc_key = @docKey,
            title = CASE WHEN @hasTitle THEN @title ELSE title END,
            format = CASE WHEN @hasFormat THEN @format ELSE format END,
            tags_json = CASE WHEN @hasTags THEN @tagsJson ELSE tags_json END,
            updated_at = @now
          WHERE id = @messageId
        `).run({
          messageId,
          docKey,
          title: input.title ?? null,
          format: format ?? null,
          tagsJson,
          hasTitle: input.title !== undefined ? 1 : 0,
          hasFormat: format !== undefined ? 1 : 0,
          hasTags: input.tags !== undefined ? 1 : 0,
          now
        });
        resolvedMessageId = messageId;
      } else {
        const existing = this.findMessageByIdentity(currentProjectKey, targetProjectKey, docKey);
        if (existing) {
          this.db.prepare(`
            UPDATE messages
            SET
              title = CASE WHEN @hasTitle THEN @title ELSE title END,
              format = CASE WHEN @hasFormat THEN @format ELSE format END,
              tags_json = CASE WHEN @hasTags THEN @tagsJson ELSE tags_json END,
              updated_at = @now
            WHERE id = @messageId
          `).run({
            messageId: existing.id,
            title: input.title ?? null,
            format: format ?? null,
            tagsJson,
            hasTitle: input.title !== undefined ? 1 : 0,
            hasFormat: format !== undefined ? 1 : 0,
            hasTags: input.tags !== undefined ? 1 : 0,
            now
          });
          resolvedMessageId = existing.id;
        } else {
          const result = this.db.prepare(`
            INSERT INTO messages (
              sender_project_key,
              target_project_key,
              doc_key,
              title,
              format,
              tags_json,
              created_at,
              updated_at
            )
            VALUES (
              @senderProjectKey,
              @targetProjectKey,
              @docKey,
              @title,
              COALESCE(@format, 'markdown'),
              COALESCE(@tagsJson, '[]'),
              @now,
              @now
            )
          `).run({
            senderProjectKey: currentProjectKey,
            targetProjectKey: targetProjectKey ?? null,
            docKey,
            title: input.title ?? null,
            format: format ?? null,
            tagsJson,
            now
          });
          resolvedMessageId = Number(result.lastInsertRowid);
        }
      }

      const versionRow = this.db.prepare(`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM message_versions
        WHERE message_id = @messageId
      `).get({ messageId: resolvedMessageId }) as VersionRow;

      this.db.prepare(`
        INSERT INTO message_versions (message_id, version, content, author_project_key, created_at)
        VALUES (@messageId, @version, @content, @authorProjectKey, @now)
      `).run({
        messageId: resolvedMessageId,
        version: versionRow.next_version,
        content,
        authorProjectKey: currentProjectKey,
        now
      });

      return this.getMessageVersionByMessageAndVersion(resolvedMessageId, versionRow.next_version);
    });

    return saveMessage();
  }

  readUnreadMessages(input: ReadUnreadMessagesInput): UnreadMessage[] {
    const currentProjectKey = parseGitRemote(input.currentProjectRemote).key;
    const deviceId = normalizeRequiredKey(input.deviceId, "Device id is required.");
    const limit = normalizeOptionalLimit(input.limit);
    const includeBroadcast = input.withBroadcast === true;
    const params: Record<string, unknown> = { currentProjectKey, deviceId };
    const limitClause = appendOptionalLimit(params, limit);

    const readMessages = this.db.transaction(() => {
      this.ensureDeviceRegistered(currentProjectKey, deviceId);

      const rows = this.db.prepare(`
        SELECT
          m.id AS message_id,
          v.id AS version_id,
          m.sender_project_key,
          m.target_project_key,
          m.doc_key,
          m.title,
          m.format,
          m.tags_json,
          v.version,
          v.content,
          v.author_project_key,
          v.created_at,
          r.read_at
        FROM messages m
        JOIN message_versions v
          ON v.id = (
            SELECT latest.id
            FROM message_versions latest
            WHERE latest.message_id = m.id
            ORDER BY latest.version DESC
            LIMIT 1
          )
        LEFT JOIN message_reads r
          ON r.message_version_id = v.id
         AND r.viewer_project_key = @currentProjectKey
         AND r.viewer_device_id = @deviceId
        WHERE m.sender_project_key <> @currentProjectKey
          AND ${inboxVisibilityCondition(includeBroadcast)}
          AND r.read_at IS NULL
        ORDER BY v.created_at DESC, v.id DESC
        ${limitClause}
      `).all(params) as MessageSearchRow[];

      if (rows.length === 0) {
        return [];
      }

      const viewedAt = new Date().toISOString();
      const markRead = this.db.prepare(`
        INSERT INTO message_reads (viewer_project_key, viewer_device_id, message_version_id, read_at)
        VALUES (@viewerProjectKey, @viewerDeviceId, @messageVersionId, @readAt)
        ON CONFLICT(viewer_project_key, viewer_device_id, message_version_id) DO UPDATE SET
          read_at = excluded.read_at
      `);

      rows.forEach((row) => {
        markRead.run({
          viewerProjectKey: currentProjectKey,
          viewerDeviceId: deviceId,
          messageVersionId: row.version_id,
          readAt: viewedAt
        });
      });

      return rows.map((row) => ({
        ...mapMessageVersionRow(row),
        viewed: true as const,
        viewedAt
      }));
    });

    return readMessages();
  }

  listMessages(input: ListMessagesInput): MessageSearchResult[] {
    const currentProjectKey = parseGitRemote(input.currentProjectRemote).key;
    const deviceId = normalizeRequiredKey(input.deviceId, "Device id is required.");
    const includeBroadcast = input.withBroadcast === true;
    const query = normalizeOptionalString(input.query);
    const tags = normalizeStringArray(input.tags ?? []);
    const limit = normalizeOptionalLimit(input.limit);
    const conditions = [
      "m.sender_project_key <> @currentProjectKey",
      inboxVisibilityCondition(includeBroadcast)
    ];
    const params: Record<string, unknown> = { currentProjectKey, deviceId };

    this.ensureDeviceRegistered(currentProjectKey, deviceId);

    if (query) {
      conditions.push("(m.doc_key LIKE @query OR m.title LIKE @query OR v.content LIKE @query)");
      params.query = `%${query}%`;
    }
    appendTagConditions(conditions, params, tags);
    const limitClause = appendOptionalLimit(params, limit);

    const rows = this.db.prepare(`
      SELECT
        m.id AS message_id,
        v.id AS version_id,
        m.sender_project_key,
        m.target_project_key,
        m.doc_key,
        m.title,
        m.format,
        m.tags_json,
        v.version,
        v.content,
        v.author_project_key,
        v.created_at,
        r.read_at
      FROM messages m
      JOIN message_versions v
        ON v.id = (
          SELECT latest.id
          FROM message_versions latest
          WHERE latest.message_id = m.id
          ORDER BY latest.version DESC
          LIMIT 1
        )
      LEFT JOIN message_reads r
        ON r.message_version_id = v.id
       AND r.viewer_project_key = @currentProjectKey
       AND r.viewer_device_id = @deviceId
      WHERE ${conditions.join(" AND ")}
      ORDER BY v.created_at DESC, v.id DESC
      ${limitClause}
    `).all(params) as MessageSearchRow[];

    return rows.map((row) => {
      const message = mapMessageVersionRow(row);
      const { content: _content, ...withoutContent } = message;
      return {
        ...withoutContent,
        preview: createPreview(message.content),
        viewed: row.read_at !== null,
        viewedAt: row.read_at
      };
    });
  }

  getMessageHistory(input: GetMessageHistoryInput): MessageVersion[] {
    const currentProjectKey = parseGitRemote(input.currentProjectRemote).key;
    const messageId = normalizeOptionalPositiveInteger(input.messageId, "Message id must be a positive integer.");
    if (messageId === undefined) {
      throw new Error("Message id is required.");
    }

    this.ensureProjectRegistered(currentProjectKey, "Current project");
    const message = this.getMessageRowOrThrow(messageId);
    this.ensureMessageAccessible(message, currentProjectKey, input.withBroadcast === true);
    const limit = normalizeOptionalLimit(input.limit);
    const params: Record<string, unknown> = { messageId };
    const limitClause = appendOptionalLimit(params, limit);

    const rows = this.db.prepare(`
      SELECT
        m.id AS message_id,
        v.id AS version_id,
        m.sender_project_key,
        m.target_project_key,
        m.doc_key,
        m.title,
        m.format,
        m.tags_json,
        v.version,
        v.content,
        v.author_project_key,
        v.created_at
      FROM messages m
      JOIN message_versions v ON v.message_id = m.id
      WHERE m.id = @messageId
      ORDER BY v.version DESC
      ${limitClause}
    `).all(params) as MessageVersionRow[];

    return rows.map(mapMessageVersionRow);
  }

  private configureDatabase(): void {
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    if (this.db.name !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
    `);

    const schemaVersion = this.db.prepare(`
      SELECT value
      FROM schema_metadata
      WHERE key = 'schema_version'
    `).get() as SchemaVersionRow | undefined;

    if (schemaVersion?.value !== MESSAGE_SCHEMA_VERSION) {
      this.resetSchema();
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        key TEXT PRIMARY KEY NOT NULL,
        remote TEXT NOT NULL,
        project_description TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_devices (
        project_key TEXT NOT NULL REFERENCES projects(key) ON UPDATE CASCADE ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        device_description TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(project_key, device_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_project_key TEXT NOT NULL REFERENCES projects(key) ON UPDATE CASCADE ON DELETE RESTRICT,
        target_project_key TEXT REFERENCES projects(key) ON UPDATE CASCADE ON DELETE RESTRICT,
        doc_key TEXT NOT NULL,
        title TEXT,
        format TEXT NOT NULL DEFAULT 'markdown',
        tags_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS message_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON UPDATE CASCADE ON DELETE CASCADE,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        author_project_key TEXT NOT NULL REFERENCES projects(key) ON UPDATE CASCADE ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        UNIQUE(message_id, version)
      );

      CREATE TABLE IF NOT EXISTS message_reads (
        viewer_project_key TEXT NOT NULL,
        viewer_device_id TEXT NOT NULL,
        message_version_id INTEGER NOT NULL REFERENCES message_versions(id) ON UPDATE CASCADE ON DELETE CASCADE,
        read_at TEXT NOT NULL,
        PRIMARY KEY(viewer_project_key, viewer_device_id, message_version_id),
        FOREIGN KEY(viewer_project_key, viewer_device_id)
          REFERENCES project_devices(project_key, device_id)
          ON UPDATE CASCADE
          ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_direct_unique
        ON messages(sender_project_key, target_project_key, doc_key)
        WHERE target_project_key IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_broadcast_unique
        ON messages(sender_project_key, doc_key)
        WHERE target_project_key IS NULL;

      CREATE INDEX IF NOT EXISTS idx_projects_remote
        ON projects(remote);

      CREATE INDEX IF NOT EXISTS idx_project_devices_last_seen
        ON project_devices(project_key, last_seen_at);

      CREATE INDEX IF NOT EXISTS idx_messages_inbox
        ON messages(target_project_key, updated_at);

      CREATE INDEX IF NOT EXISTS idx_messages_sender_updated
        ON messages(sender_project_key, updated_at);

      CREATE INDEX IF NOT EXISTS idx_message_versions_message_version
        ON message_versions(message_id, version);

      CREATE INDEX IF NOT EXISTS idx_message_versions_created_at
        ON message_versions(created_at);
    `);

    this.db.prepare(`
      INSERT INTO schema_metadata (key, value)
      VALUES ('schema_version', @schemaVersion)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run({ schemaVersion: MESSAGE_SCHEMA_VERSION });
  }

  private resetSchema(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS message_reads;
      DROP TABLE IF EXISTS message_versions;
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS project_devices;
      DROP TABLE IF EXISTS projects;
      DROP TABLE IF EXISTS doc_view_states;
      DROP TABLE IF EXISTS bridge_doc_versions;
      DROP TABLE IF EXISTS bridge_docs;
      DROP TABLE IF EXISTS project_links;
      DELETE FROM schema_metadata WHERE key = 'schema_version';
    `);
  }

  private getRegisteredProject(projectKey: string): RegisteredProject {
    const project = this.getProjectRow(projectKey);
    if (!project) {
      throw new Error(`Project is not registered: ${projectKey}.`);
    }

    return mapProjectRow(project, this.listDevicesForProject(projectKey));
  }

  private getProjectRow(projectKey: string): ProjectRow | undefined {
    return this.db.prepare(`
      SELECT key, remote, project_description, created_at
      FROM projects
      WHERE key = @projectKey
    `).get({ projectKey }) as ProjectRow | undefined;
  }

  private ensureProjectRegistered(projectKey: string, label: string): void {
    if (!this.getProjectRow(projectKey)) {
      throw new Error(`${label} is not registered: ${projectKey}. Call register_project first.`);
    }
  }

  private ensureDeviceRegistered(projectKey: string, deviceId: string): void {
    this.ensureProjectRegistered(projectKey, "Current project");
    if (!this.getDeviceRow(projectKey, deviceId)) {
      throw new Error(`Device is not registered for project ${projectKey}: ${deviceId}. Call register_project first.`);
    }
  }

  private listDevicesForProject(projectKey: string): ProjectDevice[] {
    const rows = this.db.prepare(`
      SELECT project_key, device_id, device_description, created_at, last_seen_at
      FROM project_devices
      WHERE project_key = @projectKey
      ORDER BY device_id ASC
    `).all({ projectKey }) as ProjectDeviceRow[];

    return rows.map(mapProjectDeviceRow);
  }

  private getDeviceRow(projectKey: string, deviceId: string): ProjectDeviceRow | undefined {
    return this.db.prepare(`
      SELECT project_key, device_id, device_description, created_at, last_seen_at
      FROM project_devices
      WHERE project_key = @projectKey
        AND device_id = @deviceId
    `).get({ projectKey, deviceId }) as ProjectDeviceRow | undefined;
  }

  private getDeviceRowOrThrow(projectKey: string, deviceId: string): ProjectDeviceRow {
    const device = this.getDeviceRow(projectKey, deviceId);
    if (!device) {
      throw new Error(`Device is not registered for project ${projectKey}: ${deviceId}.`);
    }

    return device;
  }

  private findMessageByIdentity(senderProjectKey: string, targetProjectKey: string | undefined, docKey: string): MessageRow | undefined {
    const targetCondition = targetProjectKey === undefined
      ? "target_project_key IS NULL"
      : "target_project_key = @targetProjectKey";

    return this.db.prepare(`
      SELECT id, sender_project_key, target_project_key, doc_key, title, format, tags_json, created_at, updated_at
      FROM messages
      WHERE sender_project_key = @senderProjectKey
        AND ${targetCondition}
        AND doc_key = @docKey
    `).get({
      senderProjectKey,
      targetProjectKey,
      docKey
    }) as MessageRow | undefined;
  }

  private getMessageRowOrThrow(messageId: number): MessageRow {
    const row = this.db.prepare(`
      SELECT id, sender_project_key, target_project_key, doc_key, title, format, tags_json, created_at, updated_at
      FROM messages
      WHERE id = ?
    `).get(messageId) as MessageRow | undefined;

    if (!row) {
      throw new Error(`Message does not exist: ${messageId}.`);
    }

    return row;
  }

  private getMessageVersionByMessageAndVersion(messageId: number, version: number): MessageVersion {
    const row = this.db.prepare(`
      SELECT
        m.id AS message_id,
        v.id AS version_id,
        m.sender_project_key,
        m.target_project_key,
        m.doc_key,
        m.title,
        m.format,
        m.tags_json,
        v.version,
        v.content,
        v.author_project_key,
        v.created_at
      FROM messages m
      JOIN message_versions v ON v.message_id = m.id
      WHERE m.id = @messageId
        AND v.version = @version
    `).get({ messageId, version }) as MessageVersionRow | undefined;

    if (!row) {
      throw new Error("Failed to load message version after saving.");
    }

    return mapMessageVersionRow(row);
  }

  private ensureMessageAccessible(message: MessageRow, currentProjectKey: string, withBroadcast: boolean): void {
    if (message.target_project_key === null) {
      if (message.sender_project_key === currentProjectKey || withBroadcast) {
        return;
      }
      throw new Error(`Broadcast message ${message.id} is not accessible to project ${currentProjectKey}. Pass withBroadcast: true to read it.`);
    }

    if (message.sender_project_key === currentProjectKey || message.target_project_key === currentProjectKey) {
      return;
    }

    throw new Error(`Message ${message.id} is not accessible to project: ${currentProjectKey}.`);
  }
}

function inboxVisibilityCondition(includeBroadcast: boolean): string {
  return includeBroadcast
    ? "(m.target_project_key = @currentProjectKey OR m.target_project_key IS NULL)"
    : "m.target_project_key = @currentProjectKey";
}

function appendTagConditions(conditions: string[], params: Record<string, unknown>, tags: string[]): void {
  tags.forEach((tag, index) => {
    const paramName = `tag${index}`;
    conditions.push(`EXISTS (SELECT 1 FROM json_each(m.tags_json) WHERE value = @${paramName})`);
    params[paramName] = tag;
  });
}

function appendOptionalLimit(params: Record<string, unknown>, limit: number | undefined): string {
  if (limit === undefined) {
    return "";
  }

  params.limit = limit;
  return "LIMIT @limit";
}

function normalizeRequiredKey(value: string | null | undefined, message: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function normalizeRequiredString(value: string | undefined, message: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeStringArray(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeOptionalPositiveInteger(value: number | undefined, message: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(message);
  }
  return value;
}

function normalizeOptionalLimit(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Limit must be a positive integer.");
  }

  return Math.min(value, 100);
}

function parseStringArray(json: string): string[] {
  const parsed = JSON.parse(json) as unknown;
  return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
}

function createPreview(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 237)}...`;
}

function mapProjectRow(row: ProjectRow, devices: ProjectDevice[]): RegisteredProject {
  return {
    key: row.key,
    remote: row.remote,
    projectDescription: row.project_description,
    createdAt: row.created_at,
    devices
  };
}

function mapProjectDeviceRow(row: ProjectDeviceRow): ProjectDevice {
  return {
    deviceId: row.device_id,
    deviceDescription: row.device_description,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at
  };
}

function mapMessageVersionRow(row: MessageVersionRow): MessageVersion {
  return {
    messageId: row.message_id,
    versionId: row.version_id,
    senderProjectKey: row.sender_project_key,
    targetProjectKey: row.target_project_key,
    docKey: row.doc_key,
    title: row.title,
    format: row.format,
    tags: parseStringArray(row.tags_json),
    version: row.version,
    content: row.content,
    authorProjectKey: row.author_project_key,
    createdAt: row.created_at
  };
}
