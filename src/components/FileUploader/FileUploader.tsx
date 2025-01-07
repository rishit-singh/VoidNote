interface FileUploaderProps {
  onFileUpload: (file: File) => Promise<void>;
  isRecording: boolean;
  localAudioBlob: Blob | null;
  fileRef: React.RefObject<HTMLInputElement | null>; // Update this type
}

export const FileUploader: React.FC<FileUploaderProps> = ({
  onFileUpload,
  isRecording,
  localAudioBlob,
  fileRef,
}) => {
  if (isRecording || localAudioBlob) return null;

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative text-sm uppercase">
        <span className="bg-neutral-900 px-3 py-1 text-gray-400">
          or upload
        </span>
      </div>
      <label
        htmlFor="audioUpload"
        className="flex flex-col items-center justify-center border-2 border-dotted border-white rounded-lg p-10 w-full max-w-md cursor-pointer hover:border-white transition-colors"
      >
        <span className="text-white mb-2">Drag & Drop or Click to Upload</span>
        <input
          id="audioUpload"
          type="file"
          accept="audio/*"
          ref={fileRef}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFileUpload(file);
          }}
        />
      </label>
    </div>
  );
};
