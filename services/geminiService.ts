import { GoogleGenAI, Modality, Type } from "@google/genai";
import { TimedChunk } from "./types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });

export const generateSpeech = async (text: string, voice: string): Promise<string | null> => {
  try {
    const speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: voice },
      },
    };
    
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: speechConfig,
      },
    });
    
    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    
    if (base64Audio) {
      return base64Audio;
    }
    return null;
  } catch (error) {
    console.error("Error generating speech:", error);
    // Re-throw original error to propagate detailed message to the UI
    throw error;
  }
};

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      // remove the header `data:mime/type;base64,`
      const base64 = result.split(',')[1];
      if (!base64) {
        reject(new Error("Failed to read Base64 from file."));
        return;
      }
      resolve(base64);
    };
    reader.onerror = error => reject(error);
  });
};

export const transcribeAndTranslate = async (file: File, targetLanguage: string): Promise<TimedChunk[]> => {
  try {
    const base64Data = await fileToBase64(file);
    const filePart = {
      inlineData: {
        mimeType: file.type,
        data: base64Data,
      },
    };
    const textPart = {
      text: `Analyze the provided audio and generate a timed script.

**TASK:**
1.  **Identify Speakers:** Detect each unique speaker and assign a consistent ID (e.g., "SPEAKER_01").
2.  **Predict Gender:** For each speaker, predict their gender ('Male', 'Female', or 'Unknown').
3.  **Transcribe or Translate:** Identify the spoken language.
    - If the language is ${targetLanguage}, provide a direct, timed **transcription**.
    - If the language is different, provide a timed **translation** into ${targetLanguage}.

**OUTPUT REQUIREMENTS:**
- The entire response MUST be a single, valid JSON array. Do not include any text, explanations, or markdown fences like \`\`\`json before or after the JSON array.
- Each element in the array must be a JSON object with these exact keys: "start", "end", "text", "speaker", "gender".

**CRITICAL FORMATTING RULE for the "text" field:**
- All string content must be valid within a JSON string.
- This means any double quotes (") within the text MUST be escaped with a backslash (e.g., "She said, \\"Let's go!\\"").
- Any backslashes (\\) within the text must ALSO be escaped (e.g., "C:\\\\Users\\\\...").
- Any newline characters within the text must be escaped as \\n.

Failure to produce a perfectly valid JSON output will break the application. Please adhere strictly to these formatting rules.`,
    };

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: { parts: [filePart, textPart] },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              start: { type: Type.NUMBER, description: 'The start time of the segment in seconds.' },
              end: { type: Type.NUMBER, description: 'The end time of the segment in seconds.' },
              text: { type: Type.STRING, description: 'The transcribed/translated text for the segment.' },
              speaker: { type: Type.STRING, description: 'A unique identifier for the speaker, e.g., "SPEAKER_01".' },
              gender: { type: Type.STRING, description: 'The predicted gender of the speaker: "Male", "Female", or "Unknown".' }
            },
            required: ['start', 'end', 'text', 'speaker', 'gender']
          }
        }
      }
    });

    // Clean and parse the JSON response
    let jsonText = response.text.trim();
    // Remove markdown fences if the model adds them
    if (jsonText.startsWith('```json')) {
      jsonText = jsonText.substring(7);
      if (jsonText.endsWith('```')) {
        jsonText = jsonText.substring(0, jsonText.length - 3);
      }
    }
    
    return JSON.parse(jsonText) as TimedChunk[];

  } catch (error) {
    console.error("Error transcribing and translating:", error);
    // Re-throw original error to propagate detailed message to the UI
    throw error;
  }
};