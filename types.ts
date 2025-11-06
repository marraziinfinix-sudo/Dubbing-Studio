export interface Voice {
  id: string; // This is what the API expects, e.g., 'Kore'
  name: string; // A user-friendly name, e.g., 'Nova'
  description: string; // e.g., '(Female, Clear & Professional)'
  language: string; // e.g., 'English'
}

export interface TimedChunk {
  start: number;
  end: number;
  text: string;
  speaker: string; // e.g., "SPEAKER_01"
  gender?: 'Male' | 'Female' | 'Unknown';
}

export const VOICES: Voice[] = [
  // English
  { id: 'Kore', name: 'Kore', description: '(Female, Clear & Professional)', language: 'English' },
  { id: 'Puck', name: 'Puck', description: '(Male, Warm & Engaging)', language: 'English' },
  { id: 'Charon', name: 'Charon', description: '(Female, Sophisticated & Calm)', language: 'English' },
  { id: 'Fenrir', name: 'Fenrir', description: '(Male, Deep & Authoritative)', language: 'English' },
  { id: 'Zephyr', name: 'Zephyr', description: '(Neutral, Friendly & Upbeat)', language: 'English' },
];