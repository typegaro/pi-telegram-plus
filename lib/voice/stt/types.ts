export type Transcription = { text: string; language?: string; duration?: number };
export interface SttBackend {
  readonly name: string;
  transcribe(file: string, language?: string): Promise<Transcription>;
  dispose?(): Promise<void>;
}
