export type ProviderConfig = {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
};

export type ProjectFile = {
  path: string;
  size: number;
  modifiedAt: string;
  language: string;
};

export type FileContent = {
  path: string;
  content: string;
};

export type ProposedFileChange = {
  path: string;
  originalContent: string;
  updatedContent: string;
  patch: string;
};

export type ChangePlan = {
  id: string;
  summary: string;
  createdAt: string;
  provider: string;
  model: string;
  changes: ProposedFileChange[];
  rawResponse: string;
};

export type ApplyResult = {
  applied: string[];
  backupDir: string;
};

