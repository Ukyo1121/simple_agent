import { useState, useRef, useEffect, Fragment } from 'react';
import {
    Send, Plus, MessageSquare, User, Bot, Loader2, StopCircle,
    Mic, ArrowLeft, Trash2, Menu, Paperclip, X, LayoutDashboard, Package, Play, Video, Sparkles
} from 'lucide-react';
import { Network, Zap, ScanLine, BrainCircuit, Cpu, RefreshCw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { API_BASE_URL } from "./config";
import remarkGfm from 'remark-gfm';

const API_URL = `${API_BASE_URL}/chat`;

function ChatMiniVideoCard({ video, onPlay }) {
    return (
        <div
            onClick={onPlay}
            className="mt-3 w-102 bg-white border border-blue-100 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-all cursor-pointer group"
        >
            <div className="relative aspect-video bg-slate-100 overflow-hidden">
                {video.thumbnail ? (
                    <img src={video.thumbnail} alt={video.title} className="w-full h-full object-cover" />
                ) : (
                    <div className="flex items-center justify-center w-full h-full bg-gradient-to-br from-indigo-50 to-violet-100">
                        <Video className="text-indigo-300" size={32} />
                    </div>
                )}
                <div className="absolute inset-0 bg-black/10 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                    <div className="w-12 h-12 bg-white/90 rounded-full flex items-center justify-center text-indigo-600 shadow-lg">
                        <Play size={22} className="ml-0.5" fill="currentColor" />
                    </div>
                </div>
            </div>
            <div className="p-3">
                <p className="text-sm font-semibold text-slate-800 truncate">{video.title}</p>
                <p className="text-xs text-indigo-500 mt-1 flex items-center gap-1">
                    <Play size={10} fill="currentColor" /> 点击播放演示
                </p>
            </div>
        </div>
    );
}

const VideoPlayerModal = ({ video, onClose }) => {
    if (!video) return null;
    return (
        <div
            className="fixed inset-0 z-[999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 transition-opacity"
            onClick={onClose}
        >
            <div
                className="relative w-full max-w-6xl bg-black rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="absolute top-0 left-0 right-0 z-10 flex justify-between items-center p-4 bg-gradient-to-b from-black/80 to-transparent">
                    <h3 className="text-white font-medium text-sm truncate pr-8">{video.title || '视频演示'}</h3>
                    <button onClick={onClose} className="text-white/70 hover:text-white bg-white/10 rounded-full p-2 transition-all hover:rotate-90">
                        <X size={18} />
                    </button>
                </div>
                <video src={video.url} controls autoPlay className="w-full h-auto max-h-[85vh] outline-none" poster={video.thumbnail}>
                    您的浏览器不支持 HTML5 视频播放。
                </video>
            </div>
        </div>
    );
};

export default function TrainingAssistant({ onBack, userId }) {
    const [threads, setThreads] = useState([]);
    const [activeThreadId, setActiveThreadId] = useState(null);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);

    const [streamBuffer, setStreamBuffer] = useState("");
    const [displayedContent, setDisplayedContent] = useState("");
    const [isTyping, setIsTyping] = useState(false);

    const messagesEndRef = useRef(null);
    const abortControllerRef = useRef(null);
    const fullStreamRef = useRef("");
    const [attachedFiles, setAttachedFiles] = useState([]);
    const [playingVideo, setPlayingVideo] = useState(null);
    const [showOperationCards, setShowOperationCards] = useState(false);
    const [showProductCards, setShowProductCards] = useState(false);

    const renderMessageContent = (text, role, hideVideo = false) => {
        if (!text) return null;
        const markdownComponents = {
            img: ({ node, ...props }) => {
                let imgSrc = props.src;
                if (imgSrc) {
                    imgSrc = imgSrc.replace(/http:\/\/localhost:\d+/g, API_BASE_URL);
                    if (imgSrc.startsWith('/images')) imgSrc = `${API_BASE_URL}${imgSrc}`;
                }
                return <img {...props} src={imgSrc} className="max-w-full h-auto rounded-xl my-3 cursor-zoom-in border border-indigo-900/20 shadow-md" onClick={() => window.open(imgSrc, '_blank')} />;
            },
            code({ node, className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || '');
                return match ? (
                    <div className="bg-gray-950 border border-indigo-900/30 rounded-xl p-3 my-3 overflow-x-auto">
                        <code className={className} {...props} style={{ color: '#c4b5fd', fontFamily: 'monospace', fontSize: 13 }}>{children}</code>
                    </div>
                ) : (
                    <code {...props} style={{ background: role === 'user' ? 'rgba(255,255,255,0.15)' : 'rgba(99,102,241,0.15)', color: role === 'user' ? '#e0e7ff' : '#a78bfa', padding: '2px 6px', borderRadius: 5, fontFamily: 'monospace', fontSize: '0.88em' }}>{children}</code>
                );
            },
            table: ({ node, ...props }) => <div className="overflow-x-auto my-3 rounded-xl border border-indigo-900/25"><table className="min-w-full text-sm" style={{ borderCollapse: 'collapse' }} {...props} /></div>,
            thead: ({ node, ...props }) => <thead style={{ background: 'rgba(99,102,241,0.12)' }} {...props} />,
            tbody: ({ node, ...props }) => <tbody {...props} />,
            tr: ({ node, ...props }) => <tr style={{ borderBottom: '1px solid rgba(99,102,241,0.1)' }} {...props} />,
            th: ({ node, ...props }) => <th style={{ padding: '9px 13px', textAlign: 'left', color: '#4f46e5', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }} {...props} />,
            td: ({ node, ...props }) => <td style={{ padding: '9px 13px', color: '#1e1b4b' }} {...props} />,
            p: ({ node, ...props }) => <p className="mb-2.5 last:mb-0 leading-relaxed" {...props} />,
            a: ({ node, ...props }) => <a className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2" target="_blank" {...props} />,
            ul: ({ node, ...props }) => <ul className="list-disc list-outside ml-5 mb-2.5 space-y-1" {...props} />,
            ol: ({ node, ...props }) => <ol className="list-decimal list-outside ml-5 mb-2.5 space-y-1" {...props} />,
            li: ({ node, ...props }) => <li className="pl-1" {...props} />,
        };
        const parts = text.split(/(<video_preview>[\s\S]*?<\/video_preview>)/g);
        return parts.map((part, index) => {
            if (part.trim().startsWith('<video_preview>')) {
                if (hideVideo) return null;
                const jsonStr = part.replace('<video_preview>', '').replace('</video_preview>', '');
                try {
                    const videoObj = JSON.parse(jsonStr);
                    if (videoObj.url && videoObj.url.startsWith('/')) videoObj.url = `${API_BASE_URL}${videoObj.url}`;
                    if (videoObj.thumbnail && videoObj.thumbnail.startsWith('/')) videoObj.thumbnail = `${API_BASE_URL}${videoObj.thumbnail}`;
                    return (
                        <div key={`video-${index}`} className="my-5">
                            <ChatMiniVideoCard video={videoObj} onPlay={() => setPlayingVideo(videoObj)} />
                        </div>
                    );
                } catch (e) {
                    console.error("解析视频数据失败:", e);
                    return <div key={`err-${index}`} className="text-red-400 text-xs border border-red-900/30 bg-red-900/10 p-2 rounded-lg">视频解析失败: {jsonStr}</div>;
                }
            }
            if (part.includes('<video_preview>') && !part.includes('</video_preview>')) {
                const textBeforeVideo = part.slice(0, part.indexOf('<video_preview>'));
                if (hideVideo) {
                    return textBeforeVideo ? (
                        <ReactMarkdown key={`md-before-${index}`} remarkPlugins={[remarkGfm]} components={markdownComponents}>
                            {textBeforeVideo}
                        </ReactMarkdown>
                    ) : null;
                }
                return (
                    <Fragment key={`partial-${index}`}>
                        {textBeforeVideo && (
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                                {textBeforeVideo}
                            </ReactMarkdown>
                        )}
                        <span className="inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full text-violet-400 bg-violet-900/20 border border-violet-700/30 mt-2">
                            <Loader2 size={12} className="animate-spin" /> 正在加载视频组件...
                        </span>
                    </Fragment>
                );
            }
            if (!part) return null;
            return (
                <ReactMarkdown key={`md-${index}`} remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {part}
                </ReactMarkdown>
            );
        });
    };

    const fetchUserThreads = async () => {
        if (!userId) return;
        try {
            const res = await fetch(`${API_BASE_URL}/threads/${userId}?thread_type=training`);
            if (res.ok) {
                const data = await res.json();
                setThreads(data);
                if (data.length > 0) {
                    if (!activeThreadId) switchThread(data[0].id);
                } else {
                    createNewThread();
                }
            }
        } catch (error) {
            console.error("获取会话列表失败:", error);
        }
    };

    useEffect(() => {
        if (userId) {
            fetchUserThreads();
        }
    }, [userId]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, displayedContent, isLoading]);

    useEffect(() => {
        if (streamBuffer.length > displayedContent.length) {
            setIsTyping(true);
            const timer = setTimeout(() => {
                setDisplayedContent(prev => streamBuffer.slice(0, prev.length + 1));
            }, 10);
            return () => clearTimeout(timer);
        } else {
            setIsTyping(false);
        }
    }, [streamBuffer, displayedContent, isLoading]);

    const loadHistory = async (threadId) => {
        setIsLoading(true);
        setMessages([]);
        setStreamBuffer("");
        setDisplayedContent("");
        try {
            const res = await fetch(`${API_BASE_URL}/history/${threadId}`);
            const data = await res.json();
            if (data.history && Array.isArray(data.history)) setMessages(data.history);
        } catch (err) {
            console.error("加载历史记录失败", err);
        } finally {
            setIsLoading(false);
        }
    };

    const createNewThread = async () => {
        console.log("🆕 createNewThread 被调用", new Date().toISOString());  // ← 加这行
        if (isLoading) return;
        setIsLoading(true);
        try {
            const res = await fetch(`${API_BASE_URL}/threads`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, thread_type: 'training' })
            });
            if (!res.ok) throw new Error("创建会话失败");
            const newThreadData = await res.json();
            const newThread = { id: newThreadData.id, title: newThreadData.title || "新会话", history: [] };
            setThreads(prev => [newThread, ...prev]);
            setActiveThreadId(newThread.id);
            setMessages([]);
            resetTyper();
        } catch (error) {
            console.error("新建会话失败:", error);
            alert("无法创建新会话，请检查网络或后端服务");
        } finally {
            setIsLoading(false);
        }
    };

    const switchThread = (id) => {
        if (isLoading && activeThreadId === id) return;
        setActiveThreadId(id);
        const targetThread = threads.find(t => t.id === id);
        if (targetThread && targetThread.title === "新会话" && (!targetThread.history || targetThread.history.length === 0)) {
            setMessages([]);
            setStreamBuffer("");
            setDisplayedContent("");
        } else {
            loadHistory(id);
        }
    };

    const resetTyper = () => {
        setStreamBuffer("");
        setDisplayedContent("");
        setIsTyping(false);
        fullStreamRef.current = "";
    };

    const handleDeleteThread = async (e, threadId) => {
        e.stopPropagation();
        if (!window.confirm("确定要删除这条历史记录吗？删除后无法恢复。")) return;
        try {
            const res = await fetch(`${API_BASE_URL}/threads/${threadId}?user_id=${userId}`, { method: 'DELETE' });
            if (res.ok) {
                const newThreads = threads.filter(t => t.id !== threadId);
                setThreads(newThreads);
                if (activeThreadId === threadId) {
                    if (newThreads.length > 0) {
                        setActiveThreadId(newThreads[0].id);
                        setMessages([]);
                    } else {
                        createNewThread();
                    }
                }
            } else {
                alert("删除失败，请重试");
            }
        } catch (error) {
            console.error("删除出错:", error);
            alert("网络错误");
        }
    };

    const handleSend = async (manualInput = null) => {
        const textToSend = manualInput || input;
        if (!textToSend.trim() || isLoading) return;
        const currentFiles = [...attachedFiles];
        const finalTempContext = currentFiles.length > 0
            ? currentFiles.map(f => ({ type: f.type, content: f.content, fileName: f.fileName || f.name, savedPath: f.savedPath }))
            : null;
        const userMessage = {
            role: "user",
            content: textToSend,
            files: currentFiles.map(f => ({ name: f.fileName || f.name, type: f.type, base64: f.type === "image" ? f.content : undefined, savedPath: f.savedPath }))
        };
        setMessages(prev => [...prev, userMessage]);
        setInput("");
        setIsLoading(true);
        setAttachedFiles([]);
        resetTyper();
        setMessages(prev => [...prev, { role: 'ai', content: "" }]);
        abortControllerRef.current = new AbortController();
        try {
            const currentThread = threads.find(t => t.id === activeThreadId);
            if (currentThread && (currentThread.title === "新会话" || currentThread.title === "New Thread")) {
                const newTitle = textToSend.length > 15 ? textToSend.substring(0, 15) + "..." : textToSend;
                setThreads(prev => prev.map(t => t.id === activeThreadId ? { ...t, title: newTitle } : t));
                fetch(`${API_BASE_URL}/threads/${activeThreadId}/title`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: newTitle })
                }).catch(err => console.warn("标题自动更新失败:", err));
            }
        } catch (err) {
            console.error("标题逻辑出错,已跳过:", err);
        }
        try {
            const response = await fetch(API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: textToSend, thread_id: activeThreadId, user_id: userId, temp_context: finalTempContext }),
                signal: abortControllerRef.current.signal
            });
            if (!response.ok) throw new Error("API Error");
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                fullContent += chunk;
                setStreamBuffer(fullContent);
            }

            console.log("🏁 [流结束] fullContent末尾200字:", fullContent.slice(-200));
            console.log("🏁 [流结束] 含video_preview:", fullContent.includes('video_preview'));

            setMessages(prev => {
                const newMsgs = [...prev];
                if (newMsgs.length > 0 && newMsgs[newMsgs.length - 1].role === 'ai') {
                    newMsgs[newMsgs.length - 1].content = fullContent;
                }
                return newMsgs;
            });
        } catch (error) {
            console.error("❌ [catch捕获]", error.name, error.message);
            if (error.name !== 'AbortError') {
                setStreamBuffer(prev => prev + "\n\n⚠️ 连接服务器失败,请检查后端。");
            }
        } finally {
            setIsLoading(false);
            abortControllerRef.current = null;
        }
    };

    const handleStop = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            setIsLoading(false);
        }
    };

    // ✅ 点击"平台操作指导"跳转到操作指导页面
    const goToOperationPage = () => {
        createNewThread();
        setShowProductCards(false);
        setShowOperationCards(true);
    };
    const goToProductPage = () => {
        createNewThread();
        setShowProductCards(true);
        setShowOperationCards(false);
    };


    return (
        <div className="flex h-screen font-sans" style={{ background: 'linear-gradient(135deg, #eef2ff 0%, #fafbff 50%, #f5f0ff 100%)', color: '#1e1b4b' }}>

            {/* 背景装饰 */}
            <div className="pointer-events-none fixed inset-0 overflow-hidden">
                <div style={{ position: 'absolute', top: '-8%', left: '-8%', width: '40vw', height: '40vw', borderRadius: '50%', background: 'radial-gradient(circle, rgba(99,102,241,0.15) 0%, transparent 65%)', filter: 'blur(50px)' }} />
                <div style={{ position: 'absolute', bottom: '-10%', right: '-8%', width: '45vw', height: '45vw', borderRadius: '50%', background: 'radial-gradient(circle, rgba(14,165,233,0.12) 0%, transparent 65%)', filter: 'blur(50px)' }} />
                <div style={{ position: 'absolute', top: '40%', left: '35%', width: '30vw', height: '30vw', borderRadius: '50%', background: 'radial-gradient(circle, rgba(168,85,247,0.08) 0%, transparent 65%)', filter: 'blur(60px)' }} />
                <div style={{ position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(rgba(99,102,241,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.035) 1px, transparent 1px)', backgroundSize: '44px 44px' }} />
            </div>

            {/* ===== 侧边栏 ===== */}
            <div
                className="flex-shrink-0 flex flex-col z-30 overflow-hidden transition-all duration-300 ease-in-out"
                style={{
                    width: isSidebarOpen ? '260px' : '0px',
                    background: 'rgba(255,255,255,0.92)',
                    borderRight: '1px solid rgba(99,102,241,0.15)',
                    backdropFilter: 'blur(20px)',
                    boxShadow: isSidebarOpen ? '4px 0 24px rgba(99,102,241,0.08)' : 'none',
                }}
            >
                <div style={{ width: 260, height: '100%', display: 'flex', flexDirection: 'column' }}>
                    <div className="flex items-center gap-2.5 px-5 py-4" style={{ borderBottom: '1px solid rgba(99,102,241,0.1)', background: 'linear-gradient(135deg, rgba(99,102,241,0.06), rgba(14,165,233,0.04))' }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'linear-gradient(135deg, #6366f1, #0ea5e9)', boxShadow: '0 0 8px rgba(99,102,241,0.5)', flexShrink: 0 }} />
                        <span className="font-bold text-sm tracking-widest" style={{ color: '#4338ca', letterSpacing: '0.1em' }}>历史会话</span>
                    </div>
                    <div className="px-4 py-3">
                        <button
                            onClick={() => createNewThread("新会话")}
                            disabled={isLoading}
                            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200"
                            style={{ background: 'linear-gradient(135deg, #6366f1, #0ea5e9)', border: 'none', color: 'white', boxShadow: '0 4px 14px rgba(99,102,241,0.3)' }}
                            onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 20px rgba(99,102,241,0.4)'; }}
                            onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 4px 14px rgba(99,102,241,0.3)'; }}
                        >
                            <Plus size={15} /> 新建会话
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto px-3 pb-4 custom-scrollbar">
                        {threads.map(thread => (
                            <button
                                key={thread.id}
                                onClick={() => switchThread(thread.id)}
                                disabled={isLoading}
                                className="group w-full text-left flex items-center gap-2.5 px-3 py-2.5 rounded-xl mb-1 text-sm transition-all duration-200"
                                style={{
                                    background: activeThreadId === thread.id ? 'linear-gradient(135deg, rgba(99,102,241,0.1), rgba(14,165,233,0.08))' : 'transparent',
                                    border: `1px solid ${activeThreadId === thread.id ? 'rgba(99,102,241,0.25)' : 'transparent'}`,
                                    color: activeThreadId === thread.id ? '#4338ca' : '#64748b',
                                }}
                                onMouseEnter={e => { if (activeThreadId !== thread.id) { e.currentTarget.style.background = 'rgba(99,102,241,0.05)'; e.currentTarget.style.color = '#4f46e5'; } }}
                                onMouseLeave={e => { if (activeThreadId !== thread.id) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#64748b'; } }}
                            >
                                <MessageSquare size={13} style={{ flexShrink: 0, color: activeThreadId === thread.id ? '#6366f1' : '#94a3b8' }} />
                                <span className="flex-1 truncate font-medium" style={{ fontSize: 13 }}>{thread.title}</span>
                                <div
                                    role="button"
                                    onClick={(e) => handleDeleteThread(e, thread.id)}
                                    className="p-1 rounded-lg opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                                    style={{ color: '#f87171' }}
                                    onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'rgba(239,68,68,0.08)'; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                    title="删除会话"
                                >
                                    <Trash2 size={13} />
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* ===== 主界面 ===== */}
            <div className="flex-1 flex flex-col relative min-w-0">

                {/* 顶部导航栏 */}
                <div
                    className="flex-shrink-0 h-14 flex items-center justify-between px-4 z-20"
                    style={{ background: 'rgba(255,255,255,0.85)', borderBottom: '1px solid rgba(99,102,241,0.12)', backdropFilter: 'blur(16px)', boxShadow: '0 1px 12px rgba(99,102,241,0.07)' }}
                >
                    <div className="flex items-center gap-2">
                        <button onClick={onBack} className="flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-200" style={{ border: '1px solid rgba(99,102,241,0.2)', color: '#6366f1', background: 'rgba(99,102,241,0.05)' }} onMouseEnter={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.12)'; e.currentTarget.style.borderColor = 'rgba(99,102,241,0.4)'; }} onMouseLeave={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.05)'; e.currentTarget.style.borderColor = 'rgba(99,102,241,0.2)'; }} title="返回"><ArrowLeft size={17} /></button>
                        <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-200" style={{ border: `1px solid ${isSidebarOpen ? 'rgba(99,102,241,0.4)' : 'rgba(99,102,241,0.2)'}`, background: isSidebarOpen ? 'rgba(99,102,241,0.12)' : 'rgba(99,102,241,0.05)', color: '#6366f1' }} onMouseEnter={e => { if (!isSidebarOpen) { e.currentTarget.style.background = 'rgba(99,102,241,0.1)'; } }} onMouseLeave={e => { if (!isSidebarOpen) { e.currentTarget.style.background = 'rgba(99,102,241,0.05)'; } }} title={isSidebarOpen ? "收起历史记录" : "展开历史记录"}><Menu size={17} /></button>
                    </div>
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-100 to-indigo-100 flex items-center justify-center border border-violet-200/50 shadow-sm">
                            <BrainCircuit size={18} className="text-violet-600" />
                        </div>
                        <span className="font-extrabold text-sm tracking-widest" style={{ background: 'linear-gradient(135deg, #4f46e5, #0ea5e9)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>华工小筑</span>
                        <div className="flex gap-1 ml-1">
                            {[0, 1, 2].map(i => (<div key={i} style={{ width: 4, height: 4, borderRadius: '50%', background: 'linear-gradient(135deg, #6366f1, #0ea5e9)', animation: `navDot 1.8s ease-in-out ${i * 0.3}s infinite` }} />))}
                        </div>
                    </div>
                    <div className="flex items-center justify-end" style={{ width: 72 }}>
                        <button
                            onClick={() => createNewThread()}
                            disabled={isLoading}
                            className="flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-200"
                            style={{ border: '1px solid rgba(99,102,241,0.2)', color: '#6366f1', background: 'rgba(99,102,241,0.05)' }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.12)'; e.currentTarget.style.borderColor = 'rgba(99,102,241,0.4)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(99,102,241,0.05)'; e.currentTarget.style.borderColor = 'rgba(99,102,241,0.2)'; }}
                            title="新建会话"
                        >
                            <RefreshCw size={15} />
                        </button>
                    </div>
                </div>

                {/* 聊天滚动区 */}
                <div className="flex-1 overflow-y-auto p-4 pb-32 custom-scrollbar">
                    <div className="max-w-3xl mx-auto space-y-5 min-h-full flex flex-col">

                        {/* 空状态欢迎区 */}
                        {messages.length === 0 && (
                            <div className="flex-1 flex flex-col items-center justify-center text-center py-12">
                                <div className="relative mb-8">
                                    <div style={{ position: 'absolute', inset: -20, background: 'radial-gradient(circle, rgba(99,102,241,0.15) 0%, transparent 70%)', borderRadius: '50%' }} />
                                    <div className="relative w-20 h-20 flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #6366f1, #0ea5e9)', borderRadius: 24, boxShadow: '0 8px 32px rgba(99,102,241,0.35), 0 2px 8px rgba(14,165,233,0.2)', border: '3px solid rgba(255,255,255,0.8)' }}>
                                        <Bot size={38} color="white" />
                                    </div>
                                    <div style={{ position: 'absolute', inset: -10, border: '1.5px dashed rgba(99,102,241,0.2)', borderRadius: '50%', animation: 'spinRing 12s linear infinite' }} />
                                </div>

                                {!showOperationCards && !showProductCards && (
                                    <>
                                        <h2 className="text-2xl font-extrabold mb-3 tracking-wide" style={{ background: 'linear-gradient(135deg, #4f46e5, #0ea5e9)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>开启智能操作指引</h2>
                                        <p className="mb-10 max-w-sm leading-relaxed text-sm" style={{ color: '#64748b' }}>点击下方模块，快速了解智能装配与互动拼图工作站的核心功能与操作流程以及华工科技核心产品介绍</p>
                                    </>
                                )}

                                {!showOperationCards && !showProductCards ? (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-lg">
                                        <button onClick={() => setShowOperationCards(true)} className="flex items-center gap-3.5 p-4 text-left rounded-2xl transition-all duration-250" style={{ background: 'rgba(255,255,255,0.9)', border: '1.5px solid rgba(99,102,241,0.2)', boxShadow: '0 2px 12px rgba(99,102,241,0.08)' }} onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.5)'; e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(99,102,241,0.18)'; }} onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(99,102,241,0.2)'; e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 2px 12px rgba(99,102,241,0.08)'; }}>
                                            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(14,165,233,0.1))', border: '1px solid rgba(99,102,241,0.18)' }}><LayoutDashboard size={20} color="#6366f1" /></div>
                                            <div><div className="font-bold text-sm mb-0.5" style={{ color: '#1e1b4b' }}>操作指导</div><div className="text-xs" style={{ color: '#94a3b8' }}>例如：平台主界面操作</div></div>
                                        </button>
                                        <button onClick={() => setShowProductCards(true)} className="flex items-center gap-3.5 p-4 text-left rounded-2xl transition-all duration-250" style={{ background: 'rgba(255,255,255,0.9)', border: '1.5px solid rgba(14,165,233,0.22)', boxShadow: '0 2px 12px rgba(14,165,233,0.08)' }} onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(14,165,233,0.5)'; e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(14,165,233,0.18)'; }} onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(14,165,233,0.22)'; e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 2px 12px rgba(14,165,233,0.08)'; }}>
                                            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg, rgba(14,165,233,0.12), rgba(168,85,247,0.1))', border: '1px solid rgba(14,165,233,0.18)' }}><Package size={20} color="#0ea5e9" /></div>
                                            <div><div className="font-bold text-sm mb-0.5" style={{ color: '#1e1b4b' }}>产品介绍</div><div className="text-xs" style={{ color: '#94a3b8' }}>例如：公司核心产品总览</div></div>
                                        </button>
                                    </div>

                                ) : showOperationCards ? (
                                    <div className="w-full max-w-2xl">
                                        <button onClick={() => setShowOperationCards(false)} className="flex items-center gap-1.5 text-xs mb-5 transition-all duration-200" style={{ color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 2px' }} onMouseEnter={e => e.currentTarget.style.opacity = '0.7'} onMouseLeave={e => e.currentTarget.style.opacity = '1'}><ArrowLeft size={13} /> 返回</button>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                                            <div className="flex flex-col rounded-2xl overflow-hidden transition-all duration-300" style={{ background: 'rgba(255,255,255,0.95)', border: '1.5px solid rgba(99,102,241,0.2)', boxShadow: '0 4px 20px rgba(99,102,241,0.12)' }}>
                                                <div style={{ height: 5, background: 'linear-gradient(90deg, #6366f1, #0ea5e9)' }} />
                                                <div className="p-6 flex flex-col flex-1">
                                                    <div className="flex items-center gap-3 mb-4"><div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(14,165,233,0.1))', border: '1px solid rgba(99,102,241,0.18)' }}><ScanLine size={22} color="#6366f1" /></div><span className="font-extrabold text-lg" style={{ color: '#1e1b4b' }}>无序识配</span></div>
                                                    <p className="text-sm leading-relaxed flex-1 mb-5" style={{ color: '#64748b' }}>基于视觉识别技术，自动扫描无序摆放的物件，智能匹配目标位置，实现高效精准的自动化分拣作业，无需人工预排列。</p>
                                                    <button onClick={() => handleSend("介绍【无序识配】")} className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all duration-200" style={{ background: 'linear-gradient(135deg, #6366f1, #0ea5e9)', color: 'white', border: 'none', boxShadow: '0 3px 10px rgba(99,102,241,0.3)', cursor: 'pointer' }} onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 18px rgba(99,102,241,0.4)'; }} onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 3px 10px rgba(99,102,241,0.3)'; }}>点击了解更多 →</button>
                                                </div>
                                            </div>
                                            <div className="flex flex-col rounded-2xl overflow-hidden transition-all duration-300" style={{ background: 'rgba(255,255,255,0.95)', border: '1.5px solid rgba(14,165,233,0.22)', boxShadow: '0 4px 20px rgba(14,165,233,0.12)' }}>
                                                <div style={{ height: 5, background: 'linear-gradient(90deg, #0ea5e9, #a855f7)' }} />
                                                <div className="p-6 flex flex-col flex-1">
                                                    <div className="flex items-center gap-3 mb-4"><div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg, rgba(14,165,233,0.12), rgba(168,85,247,0.1))', border: '1px solid rgba(14,165,233,0.18)' }}><LayoutDashboard size={22} color="#0ea5e9" /></div><span className="font-extrabold text-lg" style={{ color: '#1e1b4b' }}>你画我拼</span></div>
                                                    <p className="text-sm leading-relaxed flex-1 mb-5" style={{ color: '#64748b' }}>用户自定义目标图形或拼接方案，系统实时解析指令并驱动机械臂按图索骥完成拼装，让创意与自动化无缝融合。</p>
                                                    <button onClick={() => handleSend("介绍【你画我拼】")} className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all duration-200" style={{ background: 'linear-gradient(135deg, #0ea5e9, #a855f7)', color: 'white', border: 'none', boxShadow: '0 3px 10px rgba(14,165,233,0.3)', cursor: 'pointer' }} onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 18px rgba(14,165,233,0.4)'; }} onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 3px 10px rgba(14,165,233,0.3)'; }}>点击了解更多 →</button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                ) : (
                                    <div className="w-full max-w-3xl">
                                        <button onClick={() => setShowProductCards(false)} className="flex items-center gap-1.5 text-xs mb-5 transition-all duration-200" style={{ color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 2px' }} onMouseEnter={e => e.currentTarget.style.opacity = '0.7'} onMouseLeave={e => e.currentTarget.style.opacity = '1'}><ArrowLeft size={13} /> 返回</button>
                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                                            <div className="flex flex-col rounded-2xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.95)', border: '1.5px solid rgba(99,102,241,0.2)', boxShadow: '0 4px 20px rgba(99,102,241,0.12)' }}>
                                                <div style={{ height: 5, background: 'linear-gradient(90deg, #6366f1, #0ea5e9)' }} />
                                                <div className="p-6 flex flex-col flex-1">
                                                    <div className="flex items-center gap-3 mb-4"><div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(14,165,233,0.1))', border: '1px solid rgba(99,102,241,0.18)' }}><Network size={24} color="#6366f1" /></div><span className="font-extrabold text-lg" style={{ color: '#1e1b4b' }}>筑视分拣</span></div>
                                                    <p className="text-sm leading-relaxed flex-1 mb-5" style={{ color: '#64748b' }}>基于“机器视觉+运动控制+AI”等核心技术，提供精准识别、稳定抓取、高效切割、智能分拣与整齐码盘等全流程自动化解决方案。</p>
                                                    <button onClick={() => handleSend("介绍【筑视分拣】")} className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all duration-200" style={{ background: 'linear-gradient(135deg, #6366f1, #0ea5e9)', color: 'white', border: 'none', boxShadow: '0 3px 10px rgba(99,102,241,0.3)', cursor: 'pointer' }} onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 18px rgba(99,102,241,0.4)'; }} onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 3px 10px rgba(99,102,241,0.3)'; }}>点击了解更多 →</button>
                                                </div>
                                            </div>
                                            <div className="flex flex-col rounded-2xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.95)', border: '1.5px solid rgba(14,165,233,0.22)', boxShadow: '0 4px 20px rgba(14,165,233,0.12)' }}>
                                                <div style={{ height: 5, background: 'linear-gradient(90deg, #0ea5e9, #06b6d4)' }} />
                                                <div className="p-6 flex flex-col flex-1">
                                                    <div className="flex items-center gap-3 mb-4"><div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg, rgba(14,165,233,0.12), rgba(6,182,212,0.1))', border: '1px solid rgba(14,165,233,0.18)' }}><Zap size={24} color="#0ea5e9" /></div><span className="font-extrabold text-lg" style={{ color: '#1e1b4b' }}>筑视焊接</span></div>
                                                    <p className="text-sm leading-relaxed flex-1 mb-5" style={{ color: '#64748b' }}>深度融合视觉识别、路径规划与多机器人协同技术，突破复杂焊接场景的柔性生产瓶颈，支持平角焊、立焊、圆弧焊、包角焊等焊接作业。</p>
                                                    <button onClick={() => handleSend("介绍【筑视焊接】")} className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all duration-200" style={{ background: 'linear-gradient(135deg, #0ea5e9, #06b6d4)', color: 'white', border: 'none', boxShadow: '0 3px 10px rgba(14,165,233,0.3)', cursor: 'pointer' }} onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 18px rgba(14,165,233,0.4)'; }} onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 3px 10px rgba(14,165,233,0.3)'; }}>点击了解更多 →</button>
                                                </div>
                                            </div>
                                            <div className="flex flex-col rounded-2xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.95)', border: '1.5px solid rgba(168,85,247,0.22)', boxShadow: '0 4px 20px rgba(168,85,247,0.12)' }}>
                                                <div style={{ height: 5, background: 'linear-gradient(90deg, #a855f7, #6366f1)' }} />
                                                <div className="p-6 flex flex-col flex-1">
                                                    <div className="flex items-center gap-3 mb-4"><div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg, rgba(168,85,247,0.12), rgba(99,102,241,0.1))', border: '1px solid rgba(168,85,247,0.18)' }}><ScanLine size={24} color="#a855f7" /></div><span className="font-extrabold text-lg" style={{ color: '#1e1b4b' }}>筑视检测</span></div>
                                                    <p className="text-sm leading-relaxed flex-1 mb-5" style={{ color: '#64748b' }}>基于“AI+2D图像+3D点云”的多模态数据融合技术，不仅能对流程制造行业的产品外观进行缺陷检测，还支持三维形貌的全尺寸高精度测量需求。</p>
                                                    <button onClick={() => handleSend("介绍【筑视检测】")} className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all duration-200" style={{ background: 'linear-gradient(135deg, #a855f7, #6366f1)', color: 'white', border: 'none', boxShadow: '0 3px 10px rgba(168,85,247,0.3)', cursor: 'pointer' }} onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 18px rgba(168,85,247,0.4)'; }} onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 3px 10px rgba(168,85,247,0.3)'; }}>点击了解更多 →</button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* 消息列表 */}
                        {messages.map((msg, idx) => {
                            const isLastAiMessage = msg.role === 'ai' && idx === messages.length - 1;
                            const isThinking = isLastAiMessage && isLoading && !displayedContent;
                            const contentToShow = isLastAiMessage && streamBuffer ? displayedContent : msg.content;

                            // ===== 操作指导话题（无序识配 / 你画我拼）=====
                            const prevMsg = idx > 0 ? messages[idx - 1] : null;
                            const isTopicWuXu = prevMsg?.content?.includes("无序识配");
                            const isTopicNiHua = prevMsg?.content?.includes("你画我拼");
                            const isOperationTopic = isTopicWuXu || isTopicNiHua;

                            const userMessagesUpToNow = messages.slice(0, idx).filter(m => m.role === 'user');
                            const hasAskedWuXu = userMessagesUpToNow.some(m => m.content?.includes("无序识配"));
                            const hasAskedNiHua = userMessagesUpToNow.some(m => m.content?.includes("你画我拼"));
                            const hasAskedBoth = hasAskedWuXu && hasAskedNiHua;

                            const showOperationFollowUp = isLastAiMessage && !isLoading && !isTyping && isOperationTopic;

                            // ===== ✅ 产品话题（筑视分拣 / 筑视焊接 / 筑视检测）=====
                            const isTopicFenjian = prevMsg?.content?.includes("筑视分拣");
                            const isTopicHanjie = prevMsg?.content?.includes("筑视焊接");
                            const isTopicJiance = prevMsg?.content?.includes("筑视检测");
                            const isProductTopic = isTopicFenjian || isTopicHanjie || isTopicJiance;

                            // 哪些产品已经问过（不含当前这条对应的那个，它已经展示了）
                            const hasAskedFenjian = userMessagesUpToNow.some(m => m.content?.includes("筑视分拣"));
                            const hasAskedHanjie = userMessagesUpToNow.some(m => m.content?.includes("筑视焊接"));
                            const hasAskedJiance = userMessagesUpToNow.some(m => m.content?.includes("筑视检测"));

                            // 动态生成剩余未介绍的产品按钮（排除当前正在回答的那个）
                            const remainingProducts = [
                                (!hasAskedFenjian && !isTopicFenjian) ? {
                                    label: '筑视分拣', query: '介绍【筑视分拣】',
                                    gradient: 'linear-gradient(135deg, #6366f1, #0ea5e9)',
                                    shadow: 'rgba(99,102,241,0.3)', hoverShadow: 'rgba(99,102,241,0.5)'
                                } : null,
                                (!hasAskedHanjie && !isTopicHanjie) ? {
                                    label: '筑视焊接', query: '介绍【筑视焊接】',
                                    gradient: 'linear-gradient(135deg, #0ea5e9, #06b6d4)',
                                    shadow: 'rgba(14,165,233,0.3)', hoverShadow: 'rgba(14,165,233,0.5)'
                                } : null,
                                (!hasAskedJiance && !isTopicJiance) ? {
                                    label: '筑视检测', query: '介绍【筑视检测】',
                                    gradient: 'linear-gradient(135deg, #a855f7, #6366f1)',
                                    shadow: 'rgba(168,85,247,0.3)', hoverShadow: 'rgba(168,85,247,0.5)'
                                } : null,
                            ].filter(Boolean);

                            const showProductFollowUp = isLastAiMessage && !isLoading && !isTyping && isProductTopic;

                            // hideVideo：操作指导话题不显示视频
                            const hideVideo = isOperationTopic;

                            return (
                                <div key={idx} className={`flex gap-3 w-full ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>

                                    {msg.role === 'ai' && (
                                        <div className="w-8 h-8 flex-shrink-0 mt-0.5 rounded-xl flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #6366f1, #0ea5e9)', border: '2px solid rgba(255,255,255,0.9)', boxShadow: '0 2px 10px rgba(99,102,241,0.25)' }}>
                                            <Bot size={16} color="white" />
                                        </div>
                                    )}

                                    <div className="max-w-[83%] flex flex-col" style={{ alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                                        <div
                                            className="px-4 py-3 text-sm leading-relaxed"
                                            style={{
                                                borderRadius: msg.role === 'user' ? '16px 3px 16px 16px' : '3px 16px 16px 16px',
                                                ...(msg.role === 'user' ? {
                                                    background: 'linear-gradient(135deg, #6366f1, #0ea5e9)', color: 'white', boxShadow: '0 4px 16px rgba(99,102,241,0.3)',
                                                } : {
                                                    background: 'rgba(255,255,255,0.95)', color: '#1e293b', border: '1px solid rgba(99,102,241,0.12)', boxShadow: '0 2px 12px rgba(99,102,241,0.07)',
                                                })
                                            }}
                                        >
                                            {isThinking ? (
                                                <div className="flex items-center gap-1.5 px-1 py-0.5">
                                                    {[0, 1, 2].map(i => (<div key={i} style={{ width: 7, height: 7, borderRadius: '50%', background: 'linear-gradient(135deg, #6366f1, #0ea5e9)', animation: `bubbleBounce 1s ease-in-out ${i * 0.15}s infinite` }} />))}
                                                    <span className="text-xs ml-1.5" style={{ color: '#6366f1' }}>正在思考</span>
                                                </div>
                                            ) : (
                                                <div className={`prose prose-sm max-w-none ${msg.role === 'user' ? 'prose-invert' : 'prose-slate'}`}>
                                                    {renderMessageContent(contentToShow || msg.content, msg.role, hideVideo)}
                                                </div>
                                            )}
                                        </div>

                                        {/* ===== 操作指导追问卡片 ===== */}
                                        {showOperationFollowUp && (
                                            <div className="mt-3 w-[320px] relative group animate-in slide-in-from-bottom-4 fade-in duration-700">
                                                <div className="absolute -inset-1 bg-gradient-to-r from-violet-500/20 to-indigo-500/20 rounded-[1.5rem] blur-xl opacity-60 group-hover:opacity-100 transition-opacity duration-500"></div>
                                                <div className="relative bg-white/40 backdrop-blur-xl border border-white/60 p-4 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.08)] overflow-hidden">
                                                    <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-white to-transparent opacity-80"></div>
                                                    <div className="flex items-center gap-2.5 mb-4">
                                                        <div className="w-7 h-7 flex items-center justify-center"><Sparkles size={16} className="text-violet-500" /></div>
                                                        <p className="text-[14px] font-bold bg-clip-text text-transparent bg-gradient-to-r from-slate-800 to-slate-600 leading-tight">接下来需要为您介绍其他内容吗？</p>
                                                    </div>
                                                    <div className="flex gap-2.5">
                                                        {!hasAskedBoth && (
                                                            <button onClick={() => handleSend(isTopicWuXu ? "介绍【你画我拼】" : "介绍【无序识配】")} className="flex-1 relative overflow-hidden bg-gradient-to-r from-violet-500 to-indigo-500 hover:from-violet-600 hover:to-indigo-600 text-white text-[13px] font-medium py-2.5 px-3 rounded-xl transition-all duration-300 shadow-md shadow-violet-500/20 hover:shadow-lg hover:shadow-violet-500/40 hover:-translate-y-0.5 active:translate-y-0">
                                                                <span className="relative z-10 flex items-center justify-center gap-1.5"><Play size={12} fill="currentColor" />{isTopicWuXu ? "【你画我拼】" : "【无序识配】"}</span>
                                                            </button>
                                                        )}
                                                        <button onClick={goToProductPage} className="flex-1 w-full bg-white/50 hover:bg-white/80 backdrop-blur-md text-slate-700 border border-white/60 hover:border-violet-300 text-[13px] font-medium py-2.5 px-3 rounded-xl transition-all duration-300 shadow-sm hover:shadow hover:-translate-y-0.5 active:translate-y-0">
                                                            公司核心产品
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {/* ===== ✅ 产品追问卡片（筑视系列）===== */}
                                        {showProductFollowUp && (
                                            <div className="mt-3 w-[360px] relative group animate-in slide-in-from-bottom-4 fade-in duration-700">
                                                <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500/20 to-cyan-500/20 rounded-[1.5rem] blur-xl opacity-60 group-hover:opacity-100 transition-opacity duration-500"></div>
                                                <div className="relative bg-white/40 backdrop-blur-xl border border-white/60 p-4 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.08)] overflow-hidden">
                                                    <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-white to-transparent opacity-80"></div>
                                                    <div className="flex items-center gap-2.5 mb-4">
                                                        <div className="w-7 h-7 flex items-center justify-center"><Sparkles size={16} className="text-indigo-500" /></div>
                                                        <p className="text-[14px] font-bold bg-clip-text text-transparent bg-gradient-to-r from-slate-800 to-slate-600 leading-tight">接下来需要为您介绍其他内容吗？</p>
                                                    </div>
                                                    <div className="flex flex-wrap gap-2">
                                                        {/* 动态渲染剩余未介绍的产品 */}
                                                        {remainingProducts.map((product) => (
                                                            <button
                                                                key={product.query}
                                                                onClick={() => handleSend(product.query)}
                                                                className="flex-1 min-w-[90px] text-white text-[13px] font-medium py-2.5 px-3 rounded-xl transition-all duration-300 hover:-translate-y-0.5 active:translate-y-0"
                                                                style={{ background: product.gradient, boxShadow: `0 3px 10px ${product.shadow}` }}
                                                                onMouseEnter={e => { e.currentTarget.style.boxShadow = `0 6px 18px ${product.hoverShadow}`; }}
                                                                onMouseLeave={e => { e.currentTarget.style.boxShadow = `0 3px 10px ${product.shadow}`; }}
                                                            >
                                                                <span className="flex items-center justify-center gap-1">
                                                                    <Play size={11} fill="currentColor" />{product.label}
                                                                </span>
                                                            </button>
                                                        ))}
                                                        {/* 平台操作指导按钮（始终显示）*/}
                                                        <button
                                                            onClick={goToOperationPage}
                                                            className="flex-1 min-w-[90px] bg-white/50 hover:bg-white/80 backdrop-blur-md text-slate-700 border border-white/60 hover:border-indigo-300 text-[13px] font-medium py-2.5 px-3 rounded-xl transition-all duration-300 shadow-sm hover:shadow hover:-translate-y-0.5 active:translate-y-0"
                                                        >
                                                            平台操作指导
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    {msg.role === 'user' && (
                                        <div
                                            className="w-8 h-8 flex-shrink-0 mt-0.5 rounded-xl overflow-hidden flex items-center justify-center"
                                            style={{ border: '2px solid rgba(255,255,255,0.9)', boxShadow: '0 2px 8px rgba(99,102,241,0.12)', background: 'white' }}
                                        >
                                            <img src="avatar.jpg" alt="用户头像" className="w-6 h-6 object-contain" />
                                        </div>
                                    )}
                                </div>
                            );
                        })}

                        <div ref={messagesEndRef} className="h-2 shrink-0" />
                    </div>
                </div>

                {/* 输入框区域 */}
                <div className="absolute bottom-0 left-0 right-0 px-4 pt-6 pb-10" style={{ background: 'linear-gradient(to top, rgba(240,244,255,1) 50%, rgba(240,244,255,0.9) 75%, transparent)' }}>
                    <div className="max-w-3xl mx-auto">
                        <div className="flex items-end gap-2.5 px-3 py-2.5 rounded-2xl transition-all duration-200" style={{ background: 'rgba(255,255,255,0.95)', border: '1.5px solid rgba(99,102,241,0.2)', boxShadow: '0 4px 20px rgba(99,102,241,0.1), 0 1px 4px rgba(0,0,0,0.04)', backdropFilter: 'blur(16px)' }}>
                            <textarea
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                                placeholder="向智能分拣助手提问..."
                                className="flex-1 bg-transparent border-none outline-none resize-none text-sm leading-relaxed"
                                style={{ maxHeight: 128, padding: '4px', color: '#1e293b', fontFamily: 'inherit' }}
                                rows={1}
                                disabled={isLoading}
                                onInput={e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 128) + 'px'; }}
                                onFocus={e => { const w = e.target.closest('div[class*="rounded-2xl"]'); if (w) { w.style.borderColor = 'rgba(99,102,241,0.45)'; w.style.boxShadow = '0 4px 20px rgba(99,102,241,0.18), 0 1px 4px rgba(0,0,0,0.04)'; } }}
                                onBlur={e => { const w = e.target.closest('div[class*="rounded-2xl"]'); if (w) { w.style.borderColor = 'rgba(99,102,241,0.2)'; w.style.boxShadow = '0 4px 20px rgba(99,102,241,0.1), 0 1px 4px rgba(0,0,0,0.04)'; } }}
                            />
                            <div className="flex items-center mb-0.5">
                                {isLoading ? (
                                    <button onClick={handleStop} className="w-9 h-9 flex items-center justify-center rounded-xl transition-all duration-200" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#ef4444' }} onMouseEnter={e => e.currentTarget.style.background = 'rgba(239,68,68,0.15)'} onMouseLeave={e => e.currentTarget.style.background = 'rgba(239,68,68,0.08)'}><StopCircle size={18} /></button>
                                ) : (
                                    <button onClick={() => handleSend()} disabled={!input.trim() && attachedFiles.length === 0} className="w-9 h-9 flex items-center justify-center rounded-xl transition-all duration-200"
                                        style={input.trim() || attachedFiles.length > 0 ? { background: 'linear-gradient(135deg, #6366f1, #0ea5e9)', border: 'none', boxShadow: '0 4px 14px rgba(99,102,241,0.4)', color: 'white', cursor: 'pointer' } : { background: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.15)', color: 'rgba(99,102,241,0.35)', cursor: 'not-allowed' }}
                                        onMouseEnter={e => { if (input.trim() || attachedFiles.length > 0) { e.currentTarget.style.transform = 'scale(1.07)'; e.currentTarget.style.boxShadow = '0 6px 20px rgba(99,102,241,0.5)'; } }}
                                        onMouseLeave={e => { if (input.trim() || attachedFiles.length > 0) { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = '0 4px 14px rgba(99,102,241,0.4)'; } }}
                                    ><Send size={16} style={{ transform: 'translate(1px,-1px)' }} /></button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {playingVideo && <VideoPlayerModal video={playingVideo} onClose={() => setPlayingVideo(null)} />}

            <style>{`
                @keyframes navDot { 0%, 100% { opacity: 0.3; transform: scale(0.75); } 50% { opacity: 1; transform: scale(1.2); } }
                @keyframes bubbleBounce { 0%, 100% { transform: translateY(0); opacity: 0.5; } 50% { transform: translateY(-5px); opacity: 1; } }
                @keyframes spinRing { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
                .custom-scrollbar::-webkit-scrollbar { width: 4px; }
                .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(99,102,241,0.2); border-radius: 2px; }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(99,102,241,0.4); }
                textarea::placeholder { color: #94a3b8 !important; }
            `}</style>
        </div>
    );
}