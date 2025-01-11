// components/FileUploader/FileUploader.tsx
import React, { useState } from 'react';

import { FileAudio } from 'lucide-react';

interface FileUploaderProps {
  onFileUpload: (file: File) => Promise<void>;
  isRecording: boolean;
  localAudioBlob: Blob | null;
  fileRef: React.MutableRefObject<HTMLInputElement | null>;
}

export const FileUploader: React.FC<FileUploaderProps> = ({
  onFileUpload,
  isRecording,
  localAudioBlob,
  fileRef,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  if (isRecording || localAudioBlob) return null;

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type.startsWith('audio/')) {
      setSelectedFile(files[0]);
      await onFileUpload(files[0]);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      await onFileUpload(file);
    }
  };

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative text-sm uppercase">
        <span className="bg-neutral-900 px-3 py-1 text-gray-400">or upload</span>
      </div>
      
      <label
        htmlFor="audioUpload"
        className={`flex flex-col items-center justify-center border-2 ${
          isDragging ? 'border-blue-500 bg-blue-500/10' : 'border-dotted border-white'
        } rounded-lg p-10 w-full max-w-md cursor-pointer hover:border-white transition-colors relative`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="flex flex-col items-center gap-4">
          <FileAudio className="w-12 h-12 text-gray-400" />
          
          {selectedFile ? (
            <div className="text-center">
              <p className="text-white font-medium mb-1">{selectedFile.name}</p>
              <p className="text-sm text-gray-400">
                {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB
              </p>
            </div>
          ) : (
            <div className="text-center">
              <p className="text-white mb-1">Drag & Drop or Click to Upload</p>
              <p className="text-sm text-gray-400">Supported formats: MP3, WAV, M4A</p>
            </div>
          )}
        </div>

        <input
          id="audioUpload"
          type="file"
          accept="audio/*"
          ref={fileRef}
          onChange={handleFileChange}
          className="hidden"
        />
      </label>

      {isDragging && (
        <div className="absolute inset-0 border-2 border-blue-500 rounded-lg pointer-events-none" />
      )}
    </div>
  );
};