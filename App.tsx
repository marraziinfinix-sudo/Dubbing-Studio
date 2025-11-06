import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { generateSpeech, transcribeAndTranslate } from './services/geminiService';
import { Voice, VOICES, TimedChunk } from './types';
import AudioPlayer from './components/AudioPlayer';
import DubbedVideoPlayer from './components/DubbedVideoPlayer';
import Spinner from './components/Spinner';

// Helper to decode Base64 string to Uint8Array
const decode = (base64: string): Uint8Array => {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

// Global AudioContext for performance
const outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

// Helper to decode raw PCM audio data into an AudioBuffer
async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

// Helper to convert an AudioBuffer to a WAV Blob
const bufferToWav = (buffer: AudioBuffer): Blob => {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const bufferArray = new ArrayBuffer(length);
  const view = new DataView(bufferArray);
  const channels: Float32Array[] = [];
  let i;
  let sample;
  let offset = 0;
  let pos = 0;

  // Write WAV container
  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8); // file length - 8
  setUint32(0x45564157); // "WAVE"

  // Write "fmt " chunk
  setUint32(0x20746d66); // "fmt "
  setUint32(16); // chunk size
  setUint16(1); // format
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan); // byte rate
  setUint16(numOfChan * 2); // block align
  setUint16(16); // bits per sample

  // Write "data" chunk
  setUint32(0x61746164); // "data"
  setUint32(length - pos - 4);

  // Write interleaved PCM samples
  for (i = 0; i < buffer.numberOfChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  while (pos < length) {
    for (i = 0; i < numOfChan; i++) {
      sample = Math.max(-1, Math.min(1, channels[i][offset])); // clamp
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; // scale to 16-bit signed int
      view.setInt16(pos, sample, true);
      pos += 2;
    }
    offset++;
  }

  return new Blob([view], { type: 'audio/wav' });

  function setUint16(data: number) {
    view.setUint16(pos, data, true);
    pos += 2;
  }

  function setUint32(data: number) {
    view.setUint32(pos, data, true);
    pos += 4;
  }
};

const LANGUAGES: Record<string, string> = {
  'zh': 'Chinese (Mandarin)',
  'en': 'English',
  'fr': 'French',
  'de': 'German',
  'hi': 'Hindi',
  'it': 'Italian',
  'ja': 'Japanese',
  'ms': 'Bahasa Malaysia',
  'pt': 'Portuguese',
  'ru': 'Russian',
  'es': 'Spanish',
};

// Helper function to stitch audio segments together
const stitchAudio = async (segments: { audioB64: string, startTime: number }[]): Promise<Blob> => {
  let maxDuration = 0;

  // Decode all segments in parallel and get their durations
  const decodedSegments = await Promise.all(
    segments.map(async (segment) => {
      const audioBytes = decode(segment.audioB64);
      const audioBuffer = await decodeAudioData(audioBytes, outputAudioContext, 24000, 1);
      const endTime = segment.startTime + audioBuffer.duration;
      if (endTime > maxDuration) {
        maxDuration = endTime;
      }
      return { buffer: audioBuffer, startTime: segment.startTime };
    })
  );

  // Use OfflineAudioContext to render the final audio track
  const offlineCtx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: Math.ceil(maxDuration * 24000), // length in samples
    sampleRate: 24000,
  });

  // Schedule each decoded segment to play at its start time
  decodedSegments.forEach(({ buffer, startTime }) => {
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(offlineCtx.destination);
    source.start(startTime);
  });

  // Render the audio
  const finalBuffer = await offlineCtx.startRendering();

  // Convert the final buffer to a WAV Blob
  return bufferToWav(finalBuffer);
};


const App: React.FC = () => {
  const [originalMediaUrl, setOriginalMediaUrl] = useState<string | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [mediaType, setMediaType] = useState<'audio' | 'video' | null>(null);
  const [dubbedAudioUrl, setDubbedAudioUrl] = useState<string | null>(null);
  const [timedScript, setTimedScript] = useState<TimedChunk[]>([]);
  const [customDialog, setCustomDialog] = useState<Record<number, string>>({});
  const [speakerVoiceMap, setSpeakerVoiceMap] = useState<Record<string, string>>({});
  const [mutedSegments, setMutedSegments] = useState<Record<number, boolean>>({});
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSegmentLoading, setIsSegmentLoading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isTranslating, setIsTranslating] = useState<boolean>(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [targetLanguage, setTargetLanguage] = useState<string>('en');

  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // Derived state for unique speakers
  const uniqueSpeakers = useMemo(() => {
    const speakers = new Set(timedScript.map(chunk => chunk.speaker));
    return Array.from(speakers).sort();
  }, [timedScript]);


  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setSourceFile(file);
      setOriginalMediaUrl(url);
      setDubbedAudioUrl(null); // Clear previous dub
      setTimedScript([]); // Clear script on new file
      setCustomDialog({});
      setSpeakerVoiceMap({});
      setMutedSegments({});
      if (file.type.startsWith('video/')) {
        setMediaType('video');
      } else if (file.type.startsWith('audio/')) {
        setMediaType('audio');
      } else {
        setMediaType(null);
      }
    }
  };
  
  const handleDialogChange = (index: number, newText: string) => {
    setCustomDialog(prev => ({ ...prev, [index]: newText }));
  };
  
  const handleSpeakerChange = (index: number, newSpeakerId: string) => {
    const newScript = [...timedScript];
    newScript[index].speaker = newSpeakerId;
    setTimedScript(newScript);
  };
  
  const handleTimeChange = (index: number, field: 'start' | 'end', value: string) => {
    const newScript = [...timedScript];
    const numericValue = parseFloat(value);
    if (!isNaN(numericValue)) {
      newScript[index][field] = numericValue;
      setTimedScript(newScript);
    }
  };
  
  const handleMuteToggle = (index: number) => {
      setMutedSegments(prev => ({...prev, [index]: !prev[index] }));
  }

  const handleVoiceForSpeakerChange = (speakerId: string, voiceId: string) => {
      setSpeakerVoiceMap(prev => ({ ...prev, [speakerId]: voiceId }));
  };

  const handlePreviewSegment = async (index: number) => {
    // Stop any currently playing preview
    if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current = null;
    }

    setIsSegmentLoading(index);
    setError(null);

    try {
        const chunk = timedScript[index];
        const textToGenerate = customDialog[index] || chunk.text;
        const speakerId = chunk.speaker;
        const voiceId = speakerVoiceMap[speakerId];

        if (!voiceId) {
            alert(`Please assign a voice to ${speakerId} first.`);
            setIsSegmentLoading(null);
            return;
        }

        const finalText = textToGenerate.trim() ? textToGenerate : ".";
        const base64Audio = await generateSpeech(finalText, voiceId);

        if (!base64Audio) {
            throw new Error('Failed to generate preview audio.');
        }

        const audioBytes = decode(base64Audio);
        const audioBuffer = await decodeAudioData(audioBytes, outputAudioContext, 24000, 1);
        const wavBlob = bufferToWav(audioBuffer);
        const wavUrl = URL.createObjectURL(wavBlob);

        const audio = new Audio(wavUrl);
        previewAudioRef.current = audio;
        audio.play();
        audio.onended = () => {
            URL.revokeObjectURL(wavUrl);
            previewAudioRef.current = null;
        };

    } catch (err: any) {
        let errorMessage = "Failed to generate preview.";
        if (err?.message) {
          errorMessage = err.message;
        } else {
          errorMessage = `An unexpected error occurred during preview: ${JSON.stringify(err, null, 2)}`;
        }
        setError(errorMessage);
    } finally {
        setIsSegmentLoading(null);
    }
  };

  const handleGenerateDub = useCallback(async () => {
    if (timedScript.length === 0) {
      setError('Please provide a script to generate the dubbing.');
      return;
    }
    setIsLoading(true);
    setError(null);
    setTranslationError(null);
    setDubbedAudioUrl(null);

    try {
      // Filter out muted segments before generating audio
      const segmentsToGenerate = timedScript
        .map((chunk, index) => ({ chunk, index }))
        .filter(({ index }) => !mutedSegments[index]);
      
      // Generate audio for each unmuted segment in parallel
      const generatedSegments = await Promise.all(
        segmentsToGenerate.map(async ({ chunk, index }) => {
          const textToGenerate = customDialog[index] || chunk.text;
          const speakerId = chunk.speaker;
          const voiceId = speakerVoiceMap[speakerId];

          if (!voiceId) {
            throw new Error(`No voice selected for ${speakerId}. Please select a voice.`);
          }
          // Use a period for empty lines to generate a short silence, maintaining timing.
          const finalText = textToGenerate.trim() ? textToGenerate : ".";
          const base64Audio = await generateSpeech(finalText, voiceId);

          if (!base64Audio) {
            throw new Error(`Failed to generate audio for segment: "${finalText}"`);
          }
          return { audioB64: base64Audio, startTime: chunk.start };
        })
      );

      // Stitch the audio segments together
      const wavBlob = await stitchAudio(generatedSegments);
      const wavUrl = URL.createObjectURL(wavBlob);
      setDubbedAudioUrl(wavUrl);
    } catch (err: any) {
      let errorMessage = "An unknown error occurred during dub generation.";
      if (err && typeof err.message === 'string') {
        errorMessage = err.message;
      } else if (err) {
        // The error might be a complex object. Stringify it for display.
        errorMessage = `An unexpected error occurred: ${JSON.stringify(err, null, 2)}`;
      }
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  }, [timedScript, customDialog, speakerVoiceMap, mutedSegments]);

  const handleSave = useCallback(() => {
    if (!dubbedAudioUrl) return;

    const a = document.createElement('a');
    a.href = dubbedAudioUrl;
    a.download = 'dubbed-audio.wav';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [dubbedAudioUrl]);

  const handleReset = useCallback(() => {
    // Revoke any existing object URLs to prevent memory leaks
    if (originalMediaUrl) URL.revokeObjectURL(originalMediaUrl);
    if (dubbedAudioUrl) URL.revokeObjectURL(dubbedAudioUrl);
    
    setOriginalMediaUrl(null);
    setSourceFile(null);
    setMediaType(null);
    setDubbedAudioUrl(null);
    setTimedScript([]);
    setCustomDialog({});
    setSpeakerVoiceMap({});
    setMutedSegments({});
    setIsLoading(false);
    setError(null);
    setIsTranslating(false);
    setTranslationError(null);
    
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [originalMediaUrl, dubbedAudioUrl]);

  useEffect(() => {
    const autoTranslate = async () => {
      if (!sourceFile) {
        return;
      }
      setIsTranslating(true);
      setTranslationError(null);
      setError(null);
      setTimedScript([]);
      setCustomDialog({});
      setSpeakerVoiceMap({});
      setMutedSegments({});

      try {
        // For the AI prompt, use the common English name for Malay for best results,
        // even if the UI shows "Bahasa Malaysia".
        const langName = targetLanguage === 'ms' 
          ? 'Malay' 
          : LANGUAGES[targetLanguage] || 'the selected language';
        const translatedScript = await transcribeAndTranslate(sourceFile, langName);
        setTimedScript(translatedScript);

        const initialDialog = translatedScript.reduce((acc, chunk, index) => {
          acc[index] = chunk.text;
          return acc;
        }, {} as Record<number, string>);
        setCustomDialog(initialDialog);
    
        const speakers = Array.from(new Set(translatedScript.map(chunk => chunk.speaker))).sort();
        const initialVoiceMap = speakers.reduce((acc, speakerId, index) => {
            // Assign voices cyclically
            acc[speakerId] = VOICES[index % VOICES.length].id;
            return acc;
        }, {} as Record<string, string>);
        setSpeakerVoiceMap(initialVoiceMap);

      } catch (err: any) {
        let errorMessage = "Failed to translate. Please try again.";
        if (err && typeof err.message === 'string') {
          errorMessage = err.message;
        } else if (err) {
          // The error might be a complex object. Stringify it for display.
          errorMessage = `An unexpected error occurred during translation: ${JSON.stringify(err, null, 2)}`;
        }
        setTranslationError(errorMessage);
      } finally {
        setIsTranslating(false);
      }
    };
    autoTranslate();
  }, [sourceFile, targetLanguage]);

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center p-4 sm:p-6 md:p-8">
      <div className="w-full max-w-6xl mx-auto">
        <header className="text-center mb-8">
            <h1 className="text-4xl sm:text-5xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-indigo-600">
                Gemini Dubbing Studio
            </h1>
            <p className="mt-2 text-lg text-gray-400">
                Bring your scripts to life. Upload audio or video, translate, and generate an AI-powered dub.
            </p>
        </header>

        <main className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Left Panel: Source */}
          <div className="bg-gray-800 p-6 rounded-xl shadow-lg flex flex-col">
            <h2 className="text-2xl font-semibold mb-4 border-b border-gray-700 pb-2 text-gray-200">
                Source Media
            </h2>
            <div 
                className="flex-grow flex flex-col items-center justify-center border-2 border-dashed border-gray-600 rounded-lg p-8 cursor-pointer hover:border-indigo-500 hover:bg-gray-700/50 transition-colors"
                onClick={() => fileInputRef.current?.click()}
            >
              <input
                type="file"
                accept="audio/*,video/*"
                ref={fileInputRef}
                onChange={handleFileChange}
                className="hidden"
              />
              <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-gray-500 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="text-gray-400">
                {originalMediaUrl ? "File selected. Click to change." : "Click to upload audio or video file"}
              </p>
              <p className="text-xs text-gray-500 mt-1">MP3, WAV, MP4, etc.</p>
            </div>
             <div className="mt-4 w-full">
                {mediaType === 'audio' && originalMediaUrl && (
                    <>
                    <h3 className="text-lg font-medium text-gray-300 mb-2">Original Audio</h3>
                    <audio controls src={originalMediaUrl} className="w-full h-12 rounded-lg">
                        Your browser does not support the audio element.
                    </audio>
                    </>
                )}
                {mediaType === 'video' && originalMediaUrl && (
                    <>
                    <h3 className="text-lg font-medium text-gray-300 mb-2">Original Video</h3>
                    <video controls src={originalMediaUrl} className="w-full rounded-lg max-h-96">
                        Your browser does not support the video tag.
                    </video>
                    </>
                )}
            </div>
          </div>

          {/* Right Panel: Dubbing */}
          <div className="bg-gray-800 p-6 rounded-xl shadow-lg flex flex-col">
            <h2 className="text-2xl font-semibold mb-4 border-b border-gray-700 pb-2 text-gray-200">
                Dubbing Controls
            </h2>

            <div className="flex flex-col space-y-4 flex-grow">
              <div className='space-y-2'>
                <label htmlFor="language" className="flex items-center space-x-2 text-sm font-medium text-gray-300">
                    <span>Translate from Source Media</span>
                    {isTranslating && <Spinner />}
                </label>
                <select
                  id="language"
                  className="w-full bg-gray-700 border border-gray-600 rounded-md p-2 text-gray-200 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition"
                  value={targetLanguage}
                  onChange={(e) => setTargetLanguage(e.target.value)}
                  disabled={isTranslating}
                >
                  {Object.entries(LANGUAGES).map(([code, name]) => (
                    <option key={code} value={code}>{name}</option>
                  ))}
                </select>
                {translationError && <p className="text-red-400 text-sm mt-2 whitespace-pre-wrap">{translationError}</p>}
              </div>

              <div>
                <label htmlFor="script" className="block text-sm font-medium text-gray-300 mb-1">
                  Custom Dialog Script
                </label>
                 <div className="w-full bg-gray-900/50 border border-gray-600 rounded-md p-2 h-48 overflow-y-auto space-y-3">
                    {timedScript.length > 0 ? (
                        timedScript.map((chunk, index) => (
                            <div key={index} className="bg-gray-700/60 p-2 rounded-md">
                                <div className="flex items-center gap-2 text-xs font-mono text-indigo-300">
                                    <button
                                      onClick={() => handlePreviewSegment(index)}
                                      disabled={isLoading || isSegmentLoading !== null}
                                      className="p-1 rounded-full transition-colors bg-gray-600/50 hover:bg-gray-600/80 disabled:opacity-50 disabled:cursor-not-allowed"
                                      aria-label="Preview segment"
                                    >
                                      {isSegmentLoading === index ?
                                        <div className="h-4 w-4"><Spinner /></div> :
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                      }
                                    </button>
                                    <button onClick={() => handleMuteToggle(index)} className={`p-1 rounded-full transition-colors ${mutedSegments[index] ? 'bg-red-500/50 hover:bg-red-500/80' : 'bg-gray-600/50 hover:bg-gray-600/80'}`} aria-label={mutedSegments[index] ? 'Unmute segment' : 'Mute segment'}>
                                      {mutedSegments[index] ? 
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707a1 1 0 011.414 0v14.142a1 1 0 01-1.414 0L5.586 15z" clipRule="evenodd" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M1 1l22 22" /></svg>
                                        :
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072M17 4v16M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707a1 1 0 011.414 0v14.142a1 1 0 01-1.414 0L5.586 15z" /></svg>
                                      }
                                    </button>
                                    <select
                                      value={chunk.speaker}
                                      onChange={(e) => handleSpeakerChange(index, e.target.value)}
                                      className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 w-28 appearance-none text-center"
                                      aria-label="Speaker ID"
                                    >
                                      {uniqueSpeakers.map(speakerId => (
                                          <option key={speakerId} value={speakerId}>{speakerId}</option>
                                      ))}
                                    </select>
                                    <span>({chunk.gender}) |</span>
                                    <input
                                      type="number"
                                      value={chunk.start.toFixed(2)}
                                      onChange={(e) => handleTimeChange(index, 'start', e.target.value)}
                                      className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 w-20"
                                      step="0.01"
                                      aria-label="Start time"
                                    />
                                    <span>-</span>
                                    <input
                                      type="number"
                                      value={chunk.end.toFixed(2)}
                                      onChange={(e) => handleTimeChange(index, 'end', e.target.value)}
                                      className="bg-gray-800 border border-gray-600 rounded px-1 py-0.5 w-20"
                                      step="0.01"
                                      aria-label="End time"
                                    />
                                    <span>s</span>
                                </div>
                                <textarea
                                    className="w-full bg-gray-800 border border-gray-600 rounded-md p-1 mt-1 text-sm text-gray-200 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 transition"
                                    value={customDialog[index] || ''}
                                    onChange={(e) => handleDialogChange(index, e.target.value)}
                                    rows={2}
                                />
                            </div>
                        ))
                    ) : (
                        <div className="flex items-center justify-center h-full">
                            <p className="text-gray-500 text-sm">Upload a file to generate a script...</p>
                        </div>
                    )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">
                  Assign Voices
                </label>
                <div className="space-y-2 p-2 bg-gray-900/50 rounded-md border border-gray-600">
                  {uniqueSpeakers.length > 0 ? (
                      uniqueSpeakers.map(speakerId => (
                          <div key={speakerId} className="grid grid-cols-3 items-center gap-2">
                              <label htmlFor={`voice-${speakerId}`} className="text-sm font-medium text-gray-300 truncate col-span-1">
                                  {speakerId}
                              </label>
                              <select
                                  id={`voice-${speakerId}`}
                                  className="w-full bg-gray-700 border border-gray-600 rounded-md p-2 text-gray-200 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition col-span-2"
                                  value={speakerVoiceMap[speakerId] || ''}
                                  onChange={(e) => handleVoiceForSpeakerChange(speakerId, e.target.value)}
                              >
                                {VOICES.map((voice) => (
                                  <option key={voice.id} value={voice.id}>
                                    {voice.name} {voice.description}
                                  </option>
                                ))}
                              </select>
                          </div>
                      ))
                  ) : (
                      <p className="text-sm text-gray-500 px-1 py-2">No speakers identified yet.</p>
                  )}
                </div>
              </div>
            </div>

            {error && <p className="text-red-400 text-sm mt-4 whitespace-pre-wrap">{error}</p>}
            
            <div className="mt-4 w-full">
              {dubbedAudioUrl && (
                <>
                  {mediaType === 'video' && originalMediaUrl ? (
                    <DubbedVideoPlayer
                      videoSrc={originalMediaUrl}
                      audioSrc={dubbedAudioUrl}
                    />
                  ) : (
                    <AudioPlayer src={dubbedAudioUrl} title="Dubbed Audio" />
                  )}
                </>
              )}
            </div>

            <div className="mt-6 w-full flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-2">
               <button
                  onClick={handleGenerateDub}
                  disabled={isLoading || timedScript.length === 0}
                  className="flex-1 flex justify-center items-center h-12 px-6 font-semibold rounded-md text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 disabled:cursor-not-allowed transition-all duration-300 ease-in-out"
                >
                  {isLoading ? <Spinner /> : 'Generate'}
                </button>
                <button
                  onClick={handleSave}
                  disabled={!dubbedAudioUrl}
                  className="flex-1 flex justify-center items-center h-12 px-6 font-semibold rounded-md text-white bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed transition-all duration-300 ease-in-out"
                >
                  Save
                </button>
                <button
                  onClick={handleReset}
                  disabled={!sourceFile}
                  className="flex-1 flex justify-center items-center h-12 px-6 font-semibold rounded-md text-red-400 bg-transparent border border-red-400 hover:bg-red-500/20 disabled:border-gray-600 disabled:text-gray-600 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-all"
                >
                  Reset
                </button>
            </div>

          </div>
        </main>
      </div>
    </div>
  );
};

export default App;