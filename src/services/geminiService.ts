import { GoogleGenAI, Type, GenerateContentResponse } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export interface AudioAnalysis {
  duration: number;
  bpm: number;
  genre: string;
  mood: string;
  energy: string;
  sections: { name: string; start: number; end: number }[];
}

export interface Subtitle {
  start: number;
  end: number;
  text: string;
  section: number;
}

export async function generateProjectData(analysis: any) {
  const prompt = `
    Analyze this music metadata and generate a creative plan for a lyric music video.
    Metadata: ${JSON.stringify(analysis)}
    
    Tasks:
    1. Estimate BPM, Genre, Mood, and Energy based on the metadata (or make creative guesses if not present).
    2. Divide the song into 6 logical sections (intro, verse1, chorus, verse2, bridge, outro) with start/end timestamps.
    3. Generate original lyrics (at least 8 lines) that fit the mood.
    4. Sync these lyrics to timestamps (start/end) across the sections.
    5. Create 6 cinematic image prompts for Nano Banana (gemini-2.5-flash-image).
    
    Return the data in strict JSON format.
  `;

  const response = await ai.models.generateContent({
    model: "gemini-3.1-pro-preview",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          musicAnalysis: {
            type: Type.OBJECT,
            properties: {
              bpm: { type: Type.NUMBER },
              genre: { type: Type.STRING },
              mood: { type: Type.STRING },
              energy: { type: Type.STRING },
              sections: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    start: { type: Type.NUMBER },
                    end: { type: Type.NUMBER }
                  }
                }
              }
            }
          },
          lyrics: { type: Type.ARRAY, items: { type: Type.STRING } },
          subtitles: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                start: { type: Type.NUMBER },
                end: { type: Type.NUMBER },
                text: { type: Type.STRING },
                section: { type: Type.NUMBER }
              }
            }
          },
          imagePrompts: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                section: { type: Type.NUMBER },
                prompt: { type: Type.STRING }
              }
            }
          }
        }
      }
    }
  });

  return JSON.parse(response.text);
}

export async function generateNanoBananaImage(prompt: string) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-image",
    contents: {
      parts: [{ text: `Create a cinematic loopable visual for a music video background. ${prompt}. Requirements: highly cinematic, seamless loop feel, strong composition, no text, no watermarks.` }]
    }
  });

  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData) {
      return `data:image/png;base64,${part.inlineData.data}`;
    }
  }
  return null;
}
