import { Folder, Mic, PenSquare, Users } from "lucide-react";

import React from "react";

const LandingContent: React.FC = () => {
  const features = [
    {
      icon: <Mic className="w-6 h-6 text-green-400" strokeWidth={1.5} />,
      title: "Voice Recognition",
      description: "Effortlessly capture meeting notes using speech-to-text",
    },
    {
      icon: <PenSquare className="w-6 h-6 text-green-400" strokeWidth={1.5} />,
      title: "Smart Transcription",
      description: "Automatically transcribe and organize spoken content",
    },
    {
      icon: <Folder className="w-6 h-6 text-green-400" strokeWidth={1.5} />,
      title: "Smart Organization",
      description: "Categorize notes by meeting type or project",
    },
    {
      icon: <Users className="w-6 h-6 text-green-400" strokeWidth={1.5} />,
      title: "Team Collaboration",
      description: "Share meeting summaries with team members instantly",
    },
  ];

  return (
    <div className=" p-8 h-full flex flex-col justify-center">
      <div className="max-w-xl mx-auto">
        <h1 className="text-5xl font-bold text-green-400 mb-4">VoidNote</h1>
        <p className="text-lg text-gray-400 mb-8">
          Voice-powered note-taking for seamless meeting documentation
        </p>

        <div className="grid grid-cols-2 gap-4 mb-8">
          {features.map((feature, index) => (
            <div
              key={index}
              className="bg-neutral-900 p-4 rounded-lg border border-neutral-800 hover:border-green-500 transition-colors duration-300"
            >
              <div className="flex items-center gap-3 mb-2">
                {feature.icon}
                <h2 className="text-sm font-semibold text-white">
                  {feature.title}
                </h2>
              </div>
              <p className="text-xs text-gray-400">{feature.description}</p>
            </div>
          ))}
        </div>

        <p className="hidden lg:flex text-xs text-neutral-400 mt-8">
          Made with love by VoidNote — Empowering your voice, one note at a time
        </p>
      </div>
    </div>
  );
};

export default LandingContent;
