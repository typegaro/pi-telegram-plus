export interface TtsBackend {
  readonly name: string;
  synthesize(text: string, wavPath: string): Promise<void>;
  dispose?(): Promise<void>;
}
