import React, { useRef, useEffect } from 'react';

interface DubbedVideoPlayerProps {
  videoSrc: string;
  audioSrc: string;
}

const DubbedVideoPlayer: React.FC<DubbedVideoPlayerProps> = ({ videoSrc, audioSrc }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // FIX: Initialize useRef with null to address the "Expected 1 arguments" error and improve type safety.
  const animationFrameId = useRef<number | null>(null);

  // Sync loop to keep audio and video tightly coupled
  const syncLoop = () => {
    if (videoRef.current && audioRef.current && !videoRef.current.paused) {
      const videoTime = videoRef.current.currentTime;
      const audioTime = audioRef.current.currentTime;
      
      // Only resync if the drift is larger than a threshold (e.g., 250ms)
      // This prevents audio glitches from constant micro-adjustments.
      if (Math.abs(videoTime - audioTime) > 0.25) {
        audioRef.current.currentTime = videoTime;
      }

      animationFrameId.current = requestAnimationFrame(syncLoop);
    }
  };

  const handlePlay = () => {
    if (videoRef.current && audioRef.current) {
      // Perform an initial sync before playing
      audioRef.current.currentTime = videoRef.current.currentTime;
      audioRef.current.play();

      // Start the sync loop
      // FIX: Check if there is an animation frame to cancel to avoid runtime errors.
      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
      }
      animationFrameId.current = requestAnimationFrame(syncLoop);
    }
  };

  const handlePauseOrEnd = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      // Stop the sync loop
      // FIX: Check if there is an animation frame to cancel to avoid runtime errors.
      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
      }
    }
  };

  const handleSeeked = () => {
    if (videoRef.current && audioRef.current) {
        audioRef.current.currentTime = videoRef.current.currentTime;
    }
  };

  useEffect(() => {
    const videoElement = videoRef.current;
    if (videoElement) {
      videoElement.addEventListener('play', handlePlay);
      videoElement.addEventListener('pause', handlePauseOrEnd);
      videoElement.addEventListener('ended', handlePauseOrEnd);
      videoElement.addEventListener('seeked', handleSeeked);

      return () => {
        videoElement.removeEventListener('play', handlePlay);
        videoElement.removeEventListener('pause', handlePauseOrEnd);
        videoElement.removeEventListener('ended', handlePauseOrEnd);
        videoElement.removeEventListener('seeked', handleSeeked);
        // FIX: Check if there is an animation frame to cancel to avoid runtime errors on unmount.
        if (animationFrameId.current) {
          cancelAnimationFrame(animationFrameId.current); // Cleanup on unmount
        }
      };
    }
  }, []);

  return (
    <div>
      <h3 className="text-lg font-medium text-gray-300 mb-2">Dubbed Video</h3>
      <video
        ref={videoRef}
        src={videoSrc}
        controls
        muted // Mute the original video's audio
        className="w-full rounded-lg"
      >
        Your browser does not support the video tag.
      </video>
      {/* Hidden audio element controlled by the video */}
      <audio ref={audioRef} src={audioSrc} className="hidden" />
    </div>
  );
};

export default DubbedVideoPlayer;
