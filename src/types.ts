export type DocumentFormat = "markdown" | "text" | "json";

export type MessageVersion = {
  messageId: number;
  versionId: number;
  senderProjectKey: string;
  targetProjectKey: string | null;
  docKey: string;
  title: string | null;
  format: DocumentFormat;
  tags: string[];
  version: number;
  content: string;
  authorProjectKey: string;
  createdAt: string;
};

export type UnreadMessage = MessageVersion & {
  viewed: true;
  viewedAt: string;
};

export type MessageSearchResult = Omit<MessageVersion, "content"> & {
  preview: string;
  viewed: boolean;
  viewedAt: string | null;
};
