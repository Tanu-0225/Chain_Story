import React, { useState, useEffect, useMemo, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, onSnapshot, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore';
import { PenTool, Users, Clock, Send, ShieldAlert, CheckCircle2, ChevronRight, X, AlertTriangle, Loader2 } from 'lucide-react';

// --- FIREBASE INITIALIZATION ---
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

export default function ChainStory() {
  const [user, setUser] = useState(null);
  const [paragraphs, setParagraphs] = useState([]);
  const [queue, setQueue] = useState([]);
  const [view, setView] = useState('story'); // 'story' | 'authors'
  
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [authorName, setAuthorName] = useState('');
  
  const [draftText, setDraftText] = useState('');
  const [isBouncing, setIsBouncing] = useState(false);
  const [bounceError, setBounceError] = useState('');

  // --- AUTHENTICATION ---
  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        console.error("Auth error:", error);
      }
    };
    initAuth();

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  // --- DATA FETCHING (No complex queries per rules, sorting in memory) ---
  useEffect(() => {
    if (!user) return;

    const paragraphsRef = collection(db, 'artifacts', appId, 'public', 'data', 'chainstory_paragraphs');
    const unsubParagraphs = onSnapshot(paragraphsRef, (snapshot) => {
      const pData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      // Sort by index ascending
      pData.sort((a, b) => (a.index || 0) - (b.index || 0));
      setParagraphs(pData);
    }, (error) => console.error("Paragraphs fetch error:", error));

    const queueRef = collection(db, 'artifacts', appId, 'public', 'data', 'chainstory_queue');
    const unsubQueue = onSnapshot(queueRef, (snapshot) => {
      const qData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      // Sort by timestamp to maintain queue order
      qData.sort((a, b) => {
        const timeA = a.createdAt?.toMillis() || 0;
        const timeB = b.createdAt?.toMillis() || 0;
        return timeA - timeB;
      });
      setQueue(qData);
    }, (error) => console.error("Queue fetch error:", error));

    return () => {
      unsubParagraphs();
      unsubQueue();
    };
  }, [user]);

  // --- DERIVED STATE & LOGIC ---
  
  // Find the active writer (first person in queue whose status is 'waiting')
  const activeQueueItem = useMemo(() => {
    return queue.find(q => q.status === 'waiting');
  }, [queue]);

  const isMyTurn = activeQueueItem?.authorId === user?.uid;
  const isInQueue = queue.some(q => q.authorId === user?.uid && q.status === 'waiting');
  
  const wordCount = draftText.trim() ? draftText.trim().split(/\s+/).length : 0;
  const MAX_WORDS = 150;

  // --- ACTIONS ---

  const handleJoinQueue = async (e) => {
    e.preventDefault();
    if (!user || !authorName.trim()) return;

    const nameToSave = authorName.trim();
    if (nameToSave.length > 20) {
        alert("Name too long");
        return;
    }

    try {
      const queueRef = collection(db, 'artifacts', appId, 'public', 'data', 'chainstory_queue');
      await addDoc(queueRef, {
        authorId: user.uid,
        authorName: nameToSave.startsWith('@') ? nameToSave : `@${nameToSave.replace(/\s+/g, '')}`,
        status: 'waiting',
        createdAt: serverTimestamp()
      });
      setShowJoinModal(false);
      setAuthorName('');
    } catch (err) {
      console.error("Failed to join queue:", err);
    }
  };

  const checkAIBouncer = async (text) => {
    const apiKey = ""; // Canvas provides this
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;
    
    const prompt = `
      You are the safety bouncer for a public collaborative storytelling game. Your ONLY job is to block severely unsafe content. 
      ALLOW: General swearing, standard action/violence, dark themes, nonsense, off-topic spam.
      BLOCK: Explicit sexual content (NSFW)/erotica, Hate speech/slurs, Extreme gratuitous gore.
      Do not judge narrative quality. 
      Text to analyze: "${text}"
    `;

    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            is_safe: { type: "BOOLEAN" },
            flag_reason: { type: "STRING" }
          },
          required: ["is_safe", "flag_reason"]
        }
      }
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    const resultText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!resultText) throw new Error("Invalid AI response");
    
    return JSON.parse(resultText);
  };

  const handleSubmitParagraph = async () => {
    if (!user || !isMyTurn || !draftText.trim() || wordCount > MAX_WORDS) return;

    setIsBouncing(true);
    setBounceError('');

    try {
      // 1. Run AI Bouncer
      const bouncerResult = await checkAIBouncer(draftText);

      if (!bouncerResult.is_safe) {
        setBounceError(`BLOCKED: ${bouncerResult.flag_reason.toUpperCase()}`);
        setIsBouncing(false);
        return;
      }

      // 2. Publish
      const paragraphsRef = collection(db, 'artifacts', appId, 'public', 'data', 'chainstory_paragraphs');
      await addDoc(paragraphsRef, {
        text: draftText.trim(),
        authorId: user.uid,
        authorName: activeQueueItem.authorName,
        index: paragraphs.length,
        publishedAt: serverTimestamp()
      });

      // 3. Mark queue as done
      const activeDocRef = doc(db, 'artifacts', appId, 'public', 'data', 'chainstory_queue', activeQueueItem.id);
      await updateDoc(activeDocRef, {
        status: 'done',
        completedAt: serverTimestamp()
      });

      setDraftText('');
      setIsBouncing(false);

    } catch (err) {
      console.error("Submit error:", err);
      setBounceError("SYSTEM ERROR. TRY AGAIN.");
      setIsBouncing(false);
    }
  };

  // Simulated Timer Component
  const SimulatedTimer = () => {
    const [timeLeft, setTimeLeft] = useState(10800); // 3 hours in seconds

    useEffect(() => {
      const timer = setInterval(() => setTimeLeft(prev => prev > 0 ? prev - 1 : 0), 1000);
      return () => clearInterval(timer);
    }, []);

    const hrs = Math.floor(timeLeft / 3600).toString().padStart(2, '0');
    const mins = Math.floor((timeLeft % 3600) / 60).toString().padStart(2, '0');
    const secs = (timeLeft % 60).toString().padStart(2, '0');

    return (
      <div className="flex items-center space-x-2 text-[#5c4a3d] font-serif text-lg">
        <Clock size={18} className="opacity-70" />
        <span>{hrs}:{mins}:{secs}</span>
      </div>
    );
  };

  // --- RENDERERS ---

  if (!user) {
    return (
      <div className="min-h-screen bg-[#fbf5e9] flex items-center justify-center text-[#7a6b5d] font-serif italic text-xl">
        Opening the pages...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#fbf5e9] text-[#2c241b] font-serif selection:bg-[#d8caba] overflow-x-hidden flex justify-center">
      
      {/* VINTAGE BOOK CONTAINER */}
      <div className="w-full max-w-2xl bg-[#fbf5e9] min-h-screen flex flex-col relative shadow-[0_0_40px_rgba(0,0,0,0.03)]">
        
        {/* HEADER / CHAPTER TITLE */}
        <header className="pt-12 pb-6 px-8 flex flex-col items-center">
          <h1 className="font-serif text-3xl md:text-4xl tracking-widest uppercase text-[#2c241b] border-b border-[#2c241b] pb-4 mb-6 text-center">
            ChainStory
          </h1>
          
          <div className="flex space-x-8 text-sm tracking-widest uppercase">
            <button 
              onClick={() => setView('story')}
              className={`pb-1 border-b-2 transition-colors ${view === 'story' ? 'border-[#2c241b] text-[#2c241b]' : 'border-transparent text-[#7a6b5d] hover:text-[#2c241b]'}`}
            >
              The Tale
            </button>
            <button 
              onClick={() => setView('authors')}
              className={`pb-1 border-b-2 transition-colors ${view === 'authors' ? 'border-[#2c241b] text-[#2c241b]' : 'border-transparent text-[#7a6b5d] hover:text-[#2c241b]'}`}
            >
              Index
            </button>
          </div>
        </header>

        {/* MAIN PAGE AREA */}
        <main className="flex-1 overflow-y-auto px-8 sm:px-16 pb-64 scroll-smooth">
          {view === 'story' ? (
            <div className="space-y-4 pt-4">
              {paragraphs.length === 0 ? (
                <p className="text-center italic text-[#7a6b5d] mt-10 text-lg">
                  The pages are blank. Take the pen to begin.
                </p>
              ) : (
                paragraphs.map((p, i) => (
                  <p key={p.id} className="text-lg md:text-xl leading-relaxed md:leading-loose text-justify text-[#2c241b] indent-8 mb-4">
                    {p.text}
                    <span className="italic text-[#7a6b5d] text-base ml-2 whitespace-nowrap">— {p.authorName}</span>
                  </p>
                ))
              )}
            </div>
          ) : (
            /* AUTHORS INDEX VIEW */
            <div className="mt-8 max-w-md mx-auto pt-4">
              <h2 className="text-center italic text-[#7a6b5d] mb-10 text-xl">~ The Writers ~</h2>
              <div className="space-y-4">
                {/* Past Writers */}
                {queue.filter(q => q.status === 'done').map((q, i) => (
                  <div key={q.id} className="flex justify-between items-end border-b border-dotted border-[#d8caba] pb-1">
                    <span className="text-[#2c241b] text-lg">{q.authorName}</span>
                    <span className="text-[#7a6b5d] text-sm italic">Penned</span>
                  </div>
                ))}

                {/* Active Writer */}
                {activeQueueItem && (
                  <div className="flex justify-between items-end border-b border-[#2c241b] pb-1 font-bold mt-10 mb-6">
                    <span className="text-[#2c241b] text-lg">{activeQueueItem.authorName}</span>
                    <span className="text-[#2c241b] text-sm tracking-widest uppercase">Writing</span>
                  </div>
                )}

                {/* Waiting Queue */}
                {queue.filter(q => q.status === 'waiting' && q.id !== activeQueueItem?.id).map((q, i) => (
                  <div key={q.id} className="flex justify-between items-end border-b border-dotted border-[#d8caba] pb-1 opacity-60">
                    <span className="text-[#2c241b] text-lg">{q.authorName}</span>
                    <span className="text-[#7a6b5d] text-sm italic">Awaiting</span>
                  </div>
                ))}

                {queue.length === 0 && (
                   <p className="text-center italic text-[#7a6b5d] mt-10">No one waits in the queue.</p>
                )}
              </div>
            </div>
          )}
        </main>

        {/* BOTTOM ACTION AREA */}
        <div className="fixed sm:absolute bottom-0 w-full max-w-2xl bg-gradient-to-t from-[#fbf5e9] via-[#fbf5e9] to-transparent z-50">
          {isMyTurn ? (
            /* WRITER'S STUDIO */
            <div className="p-8 pt-16 sm:px-16">
              <div className="flex justify-between items-center mb-4 border-b border-[#d8caba] pb-2">
                <SimulatedTimer />
                <span className={`text-sm italic ${wordCount > MAX_WORDS ? 'text-[#8b2626]' : 'text-[#7a6b5d]'}`}>
                  {wordCount} / {MAX_WORDS} words
                </span>
              </div>
              
              <div className="relative mb-6">
                <textarea 
                  value={draftText}
                  onChange={(e) => setDraftText(e.target.value)}
                  placeholder="Continue the tale..."
                  className="w-full bg-transparent border-0 border-b border-[#d8caba] focus:border-[#2c241b] p-2 text-lg md:text-xl leading-relaxed md:leading-loose text-[#2c241b] placeholder:text-[#d8caba] placeholder:italic focus:outline-none focus:ring-0 resize-none h-32"
                  disabled={isBouncing}
                />
                
                {bounceError && (
                  <div className="absolute inset-0 bg-[#fbf5e9]/95 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center z-10 border border-[#8b2626]">
                    <p className="font-serif text-[#8b2626] text-sm tracking-widest uppercase border-y border-[#8b2626] py-3 mb-4">
                      {bounceError}
                    </p>
                    <button 
                      onClick={() => setBounceError('')}
                      className="italic text-[#2c241b] underline decoration-[#7a6b5d] hover:text-[#8b2626] transition-colors"
                    >
                      Amend Draft
                    </button>
                  </div>
                )}

                {isBouncing && (
                  <div className="absolute inset-0 bg-[#fbf5e9]/90 backdrop-blur-sm flex flex-col items-center justify-center z-10">
                    <Loader2 className="text-[#2c241b] animate-spin mb-3" size={28} />
                    <span className="text-sm font-serif italic text-[#7a6b5d]">Consulting the editor...</span>
                  </div>
                )}
              </div>

              <button 
                onClick={handleSubmitParagraph}
                disabled={!draftText.trim() || wordCount > MAX_WORDS || isBouncing}
                className="w-full border border-[#2c241b] text-[#2c241b] uppercase tracking-widest py-4 hover:bg-[#2c241b] hover:text-[#fbf5e9] transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[#2c241b]"
              >
                Sign & Publish
              </button>
            </div>
          ) : !isInQueue ? (
            /* TAKE THE PEN BUTTON */
            <div className="p-8 pt-24 pb-12 flex justify-center">
              <button 
                onClick={() => setShowJoinModal(true)}
                className="border border-[#2c241b] text-[#2c241b] px-10 py-4 uppercase tracking-widest hover:bg-[#2c241b] hover:text-[#fbf5e9] transition-colors shadow-sm flex items-center space-x-3"
              >
                <PenTool size={18} />
                <span>Take the Pen</span>
              </button>
            </div>
          ) : (
            /* WAITING STATE */
            <div className="p-8 pt-24 pb-12 text-center">
              <p className="text-[#2c241b] uppercase tracking-widest text-sm mb-1">Queue Joined</p>
              <p className="text-[#7a6b5d] italic">Pray, await your turn.</p>
            </div>
          )}
        </div>

        {/* JOIN QUEUE MODAL */}
        {showJoinModal && (
          <div className="absolute inset-0 z-50 bg-[#2c241b]/20 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-[#fbf5e9] w-full max-w-sm p-8 shadow-2xl border border-[#d8caba]">
              <div className="flex justify-between items-center mb-6 border-b border-[#2c241b] pb-4">
                <h3 className="font-serif text-2xl text-[#2c241b] italic">Take the Pen</h3>
                <button onClick={() => setShowJoinModal(false)} className="text-[#7a6b5d] hover:text-[#2c241b] transition-colors">
                  <X size={24} />
                </button>
              </div>
              
              <form onSubmit={handleJoinQueue}>
                <div className="mb-8">
                  <label className="block text-sm italic text-[#7a6b5d] mb-4">How shall we know you?</label>
                  <input 
                    type="text" 
                    required
                    maxLength={20}
                    value={authorName.replace('@', '')}
                    onChange={(e) => setAuthorName(e.target.value)}
                    className="w-full bg-transparent border-0 border-b border-[#7a6b5d] py-2 text-[#2c241b] text-xl focus:ring-0 focus:outline-none focus:border-[#2c241b] placeholder:text-[#d8caba] font-serif"
                    placeholder="Your name or moniker"
                  />
                </div>
                
                <button 
                  type="submit"
                  disabled={!authorName.trim()}
                  className="w-full bg-[#2c241b] text-[#fbf5e9] uppercase tracking-widest py-4 hover:bg-[#1a1510] disabled:opacity-50 transition-colors"
                >
                  Join Queue
                </button>
              </form>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}