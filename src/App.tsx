import React, { useState, useEffect, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import { motion, AnimatePresence } from 'motion/react';
import { Upload, Music, Play, Pause, Loader2, CheckCircle, AlertCircle, Image as ImageIcon, Type as TypeIcon } from 'lucide-react';
import { db, auth } from './firebase';
import { collection, addDoc, onSnapshot, doc, updateDoc, getDocFromServer, serverTimestamp } from 'firebase/firestore';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from 'firebase/auth';
import { generateProjectData, generateNanoBananaImage } from './services/geminiService';
import axios from 'axios';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  
  if (errInfo.error.includes('quota') || errInfo.error.includes('resource-exhausted')) {
    throw new Error('Firestore quota exceeded. Please try again tomorrow.');
  }
  
  throw new Error(JSON.stringify(errInfo));
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: any }> {
  state = { hasError: false, error: null as any };

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  render() {
    const { children } = (this as any).props;
    if ((this as any).state.hasError) {
      return (
        <div className="min-h-screen bg-black flex items-center justify-center p-6 text-center">
          <div className="space-y-4">
            <AlertCircle size={48} className="text-red-500 mx-auto" />
            <h1 className="text-2xl font-bold">Something went wrong</h1>
            <p className="text-zinc-500 max-w-md">{(this as any).state.error?.message || 'An unexpected error occurred.'}</p>
            <button 
              onClick={() => window.location.reload()}
              className="px-6 py-2 bg-white text-black rounded-lg font-bold"
            >
              Reload App
            </button>
          </div>
        </div>
      );
    }
    return children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <VibeSyncApp />
    </ErrorBoundary>
  );
}

function VibeSyncApp() {
  const [file, setFile] = useState<File | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
    });

    // Validate connection to Firestore
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    };
    testConnection();

    return () => unsub();
  }, []);

  const handleGoogleSignIn = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      console.error(err);
      setError('Failed to sign in with Google.');
    }
  };

  const handleSignOut = () => signOut(auth);

  useEffect(() => {
    if (projectId) {
      const unsub = onSnapshot(doc(db, 'projects', projectId), (doc) => {
        if (doc.exists()) {
          setProject(doc.data());
        }
      }, (error) => {
        handleFirestoreError(error, OperationType.GET, `projects/${projectId}`);
      });
      return () => unsub();
    }
  }, [projectId]);

  const onDrop = (acceptedFiles: File[]) => {
    setFile(acceptedFiles[0]);
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'audio/*': ['.mp3', '.wav', '.m4a'] },
    multiple: false
  } as any);

  const handleUpload = async () => {
    if (!file || !user) return;
    setLoading(true);
    setError(null);

    let docRef: any = null;
    try {
      const formData = new FormData();
      formData.append('audio', file);

      // 1. Analyze audio on backend
      const analysisRes = await axios.post('/api/analyze-audio', formData);
      const analysisData = analysisRes.data;

      // 2. Create project in Firestore (Initial write)
      try {
        docRef = await addDoc(collection(db, 'projects'), {
          userId: user.uid,
          title: file.name,
          audioUrl: `/uploads/${analysisData.filename}`,
          status: 'analyzing',
          createdAt: serverTimestamp(),
        });
        setProjectId(docRef.id);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, 'projects');
      }

      // 3. Generate lyrics and prompts via Gemini
      const genData = await generateProjectData(analysisData);
      
      // 4. Generate images for each section
      const imageUrls: string[] = [];
      for (const item of genData.imagePrompts) {
        const base64 = await generateNanoBananaImage(item.prompt);
        if (base64) {
          // Save image to server to avoid Firestore payload limits
          const saveRes = await axios.post('/api/save-image', { base64Data: base64 });
          imageUrls.push(saveRes.data.url);
        }
      }

      // 5. Final Update (Combine steps to reduce writes)
      try {
        await updateDoc(docRef, {
          ...genData,
          imageUrls,
          status: 'ready'
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `projects/${docRef.id}`);
      }

    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const togglePlay = () => {
    if (audioRef.current) {
      if (isPlaying) audioRef.current.pause();
      else audioRef.current.play();
      setIsPlaying(!isPlaying);
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const getCurrentSection = () => {
    if (!project?.musicAnalysis?.sections) return 0;
    const sectionIndex = project.musicAnalysis.sections.findIndex((s: any) => 
      currentTime >= s.start && currentTime <= s.end
    );
    return sectionIndex !== -1 ? sectionIndex : 0;
  };

  const getCurrentLyric = () => {
    if (!project?.subtitles) return '';
    const lyric = project.subtitles.find((s: any) => 
      currentTime >= s.start && currentTime <= s.end
    );
    return lyric ? lyric.text : '';
  };

  const currentSection = getCurrentSection();
  const currentImage = project?.imageUrls?.[currentSection] || project?.imageUrls?.[0];

  return (
    <div className="min-h-screen bg-[#050505] text-white font-sans selection:bg-orange-500/30">
      {/* Background Atmosphere */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-orange-600/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-600/10 blur-[120px] rounded-full" />
      </div>

      <main className="relative z-10 max-w-7xl mx-auto px-6 py-12">
        <header className="mb-16 flex justify-between items-start">
          <div>
            <motion.h1 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-7xl font-bold tracking-tighter mb-4"
            >
              VIBESYNC <span className="text-orange-500 italic font-serif">AI</span>
            </motion.h1>
            <p className="text-zinc-400 text-lg max-w-2xl">
              Transform your music into a cinematic visual experience. 
              AI-generated lyrics, loopable visuals, and perfect synchronization.
            </p>
          </div>
          {user && (
            <button 
              onClick={handleSignOut}
              className="text-sm font-mono text-zinc-500 hover:text-white transition-colors"
            >
              [ SIGN OUT ]
            </button>
          )}
        </header>

        {!user ? (
          <div className="h-[50vh] flex flex-col items-center justify-center text-center space-y-8">
            <div className="space-y-4">
              <h2 className="text-4xl font-bold tracking-tight">Welcome to VibeSync</h2>
              <p className="text-zinc-500 max-w-md mx-auto">Please sign in with Google to start creating your AI music videos.</p>
            </div>
            <button
              onClick={handleGoogleSignIn}
              className="px-8 py-4 bg-white text-black rounded-2xl font-bold text-lg hover:scale-105 transition-transform flex items-center gap-3"
            >
              <img src="https://www.google.com/favicon.ico" className="w-5 h-5" alt="Google" />
              Continue with Google
            </button>
          </div>
        ) : !project ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
            <motion.div 
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              className="space-y-8"
            >
              <div 
                {...getRootProps()} 
                className={`
                  border-2 border-dashed rounded-3xl p-12 text-center cursor-pointer transition-all
                  ${isDragActive ? 'border-orange-500 bg-orange-500/5' : 'border-zinc-800 hover:border-zinc-700 bg-zinc-900/50'}
                `}
              >
                <input {...getInputProps()} />
                <div className="w-16 h-16 bg-zinc-800 rounded-2xl flex items-center justify-center mx-auto mb-6">
                  <Upload className="text-orange-500" />
                </div>
                {file ? (
                  <div className="space-y-2">
                    <p className="text-xl font-medium">{file.name}</p>
                    <p className="text-zinc-500 text-sm">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xl font-medium">Drop your track here</p>
                    <p className="text-zinc-500 text-sm">MP3, WAV, or M4A supported</p>
                  </div>
                )}
              </div>

              <button
                onClick={handleUpload}
                disabled={!file || loading}
                className={`
                  w-full py-6 rounded-2xl text-xl font-bold tracking-tight transition-all
                  ${!file || loading 
                    ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed' 
                    : 'bg-orange-500 hover:bg-orange-600 text-black active:scale-[0.98]'}
                `}
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-3">
                    <Loader2 className="animate-spin" />
                    PROCESSING...
                  </span>
                ) : (
                  'GENERATE VIDEO'
                )}
              </button>

              {error && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3 text-red-400">
                  <AlertCircle size={20} />
                  {error}
                </div>
              )}
            </motion.div>

            <motion.div 
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              className="bg-zinc-900/30 border border-zinc-800 rounded-3xl p-8"
            >
              <h3 className="text-sm font-mono text-zinc-500 uppercase tracking-widest mb-8">Pipeline Steps</h3>
              <div className="space-y-6">
                {[
                  { icon: Music, label: 'Audio Analysis', desc: 'BPM, Mood & Structure detection' },
                  { icon: TypeIcon, label: 'Lyric Generation', desc: 'AI-written original lyrics' },
                  { icon: ImageIcon, label: 'Visual Synthesis', desc: '6 unique loopable scenes' },
                  { icon: CheckCircle, label: 'Final Sync', desc: 'Beat-aligned subtitle overlay' },
                ].map((step, i) => (
                  <div key={i} className="flex gap-4">
                    <div className="w-10 h-10 rounded-xl bg-zinc-800/50 flex items-center justify-center shrink-0">
                      <step.icon size={18} className="text-zinc-400" />
                    </div>
                    <div>
                      <p className="font-medium">{step.label}</p>
                      <p className="text-sm text-zinc-500">{step.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>
        ) : (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-8"
          >
            {project.status !== 'ready' ? (
              <div className="h-[60vh] flex flex-col items-center justify-center text-center space-y-6">
                <div className="relative">
                  <div className="w-24 h-24 border-4 border-orange-500/20 border-t-orange-500 rounded-full animate-spin" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Music className="text-orange-500 animate-pulse" />
                  </div>
                </div>
                <div className="space-y-2">
                  <h2 className="text-3xl font-bold uppercase tracking-tighter">
                    {project.status.replace('_', ' ')}...
                  </h2>
                  <p className="text-zinc-500">Our AI is crafting your visual masterpiece.</p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 space-y-6">
                  {/* Video Player Area */}
                  <div className="relative aspect-video bg-zinc-900 rounded-3xl overflow-hidden border border-zinc-800 group shadow-2xl">
                    <AnimatePresence mode="wait">
                      <motion.img
                        key={currentImage}
                        src={currentImage}
                        initial={{ opacity: 0, scale: 1.1 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 1.5 }}
                        className="absolute inset-0 w-full h-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    </AnimatePresence>
                    
                    {/* Overlay Gradient */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20" />

                    {/* Subtitles */}
                    <div className="absolute bottom-12 inset-x-0 text-center px-12">
                      <AnimatePresence mode="wait">
                        <motion.p
                          key={getCurrentLyric()}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          className="text-3xl md:text-4xl font-bold tracking-tight drop-shadow-lg"
                        >
                          {getCurrentLyric()}
                        </motion.p>
                      </AnimatePresence>
                    </div>

                    {/* Play Button Overlay */}
                    {!isPlaying && (
                      <button 
                        onClick={togglePlay}
                        className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <div className="w-20 h-20 bg-orange-500 rounded-full flex items-center justify-center text-black">
                          <Play fill="currentColor" size={32} />
                        </div>
                      </button>
                    )}
                  </div>

                  {/* Controls */}
                  <div className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-6 flex items-center gap-6">
                    <button 
                      onClick={togglePlay}
                      className="w-12 h-12 bg-white text-black rounded-full flex items-center justify-center hover:scale-105 transition-transform"
                    >
                      {isPlaying ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
                    </button>
                    <div className="flex-1 h-1 bg-zinc-800 rounded-full relative">
                      <div 
                        className="absolute inset-y-0 left-0 bg-orange-500 rounded-full"
                        style={{ width: `${(currentTime / (audioRef.current?.duration || 1)) * 100}%` }}
                      />
                    </div>
                    <span className="font-mono text-sm text-zinc-500">
                      {Math.floor(currentTime / 60)}:{(currentTime % 60).toFixed(0).padStart(2, '0')}
                    </span>
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="bg-zinc-900/50 border border-zinc-800 rounded-3xl p-6 space-y-6">
                    <h3 className="text-sm font-mono text-zinc-500 uppercase tracking-widest">Track Info</h3>
                    <div className="space-y-4">
                      <div className="flex justify-between items-center">
                        <span className="text-zinc-400">BPM</span>
                        <span className="font-bold">{project.musicAnalysis.bpm}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-zinc-400">Genre</span>
                        <span className="font-bold uppercase">{project.musicAnalysis.genre}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-zinc-400">Mood</span>
                        <span className="font-bold italic">{project.musicAnalysis.mood}</span>
                      </div>
                    </div>
                  </div>

                  <div className="bg-zinc-900/50 border border-zinc-800 rounded-3xl p-6 space-y-4">
                    <h3 className="text-sm font-mono text-zinc-500 uppercase tracking-widest">Lyrics</h3>
                    <div className="max-h-[300px] overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                      {project.lyrics.map((line: string, i: number) => (
                        <p key={i} className={`text-sm ${getCurrentLyric() === line ? 'text-orange-500 font-bold' : 'text-zinc-400'}`}>
                          {line}
                        </p>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
            
            <audio 
              ref={audioRef} 
              src={project.audioUrl} 
              onTimeUpdate={handleTimeUpdate}
              onEnded={() => setIsPlaying(false)}
            />
          </motion.div>
        )}
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #27272a;
          border-radius: 10px;
        }
      `}</style>
    </div>
  );
}
