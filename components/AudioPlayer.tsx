
import React from 'react';

interface AudioPlayerProps {
  src: string | null;
  title: string;
}

const AudioPlayer: React.FC<AudioPlayerProps> = ({ src, title }) => {
  if (!src) return null;

  return (
    <div className="mt-4 w-full">
      <h3 className="text-lg font-medium text-gray-300 mb-2">{title}</h3>
      <audio controls src={src} className="w-full h-12 rounded-lg">
        Your browser does not support the audio element.
      </audio>
    </div>
  );
};

export default AudioPlayer;
