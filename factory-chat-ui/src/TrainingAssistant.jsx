import { useState, useRef, useEffect } from 'react';
import {
    Send, Plus, MessageSquare, User, Bot, Loader2, StopCircle,
    Mic, ArrowLeft, GraduationCap, Trash2, Menu, Paperclip, X, LayoutDashboard, Package, Play, Video
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { API_BASE_URL } from "./config";
import remarkGfm from 'remark-gfm';

const API_URL = `${API_BASE_URL}/chat`;
const VOICE_API_URL = `${API_BASE_URL}/voice`;

function ChatMiniVideoCard({ video, onPlay }) {
    return (
        <div
            onClick={onPlay}
            className="mt-3 w-64 bg-white/90 backdrop-blur-sm border border-slate-200/60 rounded-2xl overflow-hidden shadow-md hover:shadow-xl hover:-translate-y-1 hover:border-violet-300 transition-all duration-300 cursor-pointer group"
        >
            <div className="relative aspect-video bg-slate-100 overflow-hidden">
                {video.thumbnail ? (
                    <img src={video.thumbnail} alt={video.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                ) : (
                    <div className="flex items-center justify-center w-full h-full bg-gradient-to-br from-slate-100 to-slate-200">
                        <Video className="text-slate-300" size={32} />
                    </div>
                )}
                {/* 悬停播放遮罩 */}
                <div className="absolute inset-0 bg-slate-900/10 group-hover:bg-slate-900/40 transition-colors duration-300 flex items-center justify-center">
                    <div className="w-14 h-14 bg-white/95 backdrop-blur-md rounded-full flex items-center justify-center text-violet-600 shadow-xl opacity-90 group-hover:scale-110 group-hover:opacity-100 transition-all duration-300">
                        <Play size={26} className="ml-1" fill="currentColor" />
                    </div>
                </div>
            </div>
            <div className="p-4 bg-gradient-to-b from-white to-slate-50">
                <p className="text-sm font-bold text-slate-800 truncate">{video.title}</p>
                <p className="text-xs text-violet-600 font-medium mt-1.5 flex items-center gap-1.5 opacity-80 group-hover:opacity-100 transition-opacity">
                    <div className="w-5 h-5 rounded-full bg-violet-100 flex items-center justify-center">
                        <Play size={10} fill="currentColor" />
                    </div>
                    点击播放演示
                </p>
            </div>
        </div>
    );
}

// 🎬 视频播放模态框组件
const VideoPlayerModal = ({ video, onClose }) => {
    if (!video) return null;

    return (
        <div
            className="fixed inset-0 z-[999] flex items-center justify-center bg-slate-900/80 backdrop-blur-md p-4 transition-opacity"
            onClick={onClose}
        >
            <div
                className="relative w-full max-w-4xl bg-black rounded-2xl shadow-2xl ring-1 ring-white/10 overflow-hidden animate-in fade-in zoom-in-95 duration-300"
                onClick={(e) => e.stopPropagation()}
            >
                {/* 顶部悬浮栏：标题 + 关闭按钮 */}
                <div className="absolute top-0 left-0 right-0 z-10 flex justify-between items-center p-4 bg-gradient-to-b from-black/90 via-black/50 to-transparent">
                    <h3 className="text-white font-medium text-sm md:text-base truncate pr-8 tracking-wide">
                        {video.title || '视频演示'}
                    </h3>
                    <button
                        onClick={onClose}
                        className="text-white/70 hover:text-white bg-white/10 hover:bg-white/20 backdrop-blur-sm rounded-full p-2 transition-all hover:rotate-90"
                        title="关闭"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* 核心视频播放器 */}
                <video
                    src={video.url}
                    controls
                    autoPlay
                    className="w-full h-auto max-h-[85vh] outline-none"
                    poster={video.thumbnail}
                >
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
    const [attachedFiles, setAttachedFiles] = useState([]);
    const [playingVideo, setPlayingVideo] = useState(null);

    const renderMessageContent = (text, role) => {
        if (!text) return null;

        const parts = text.split(/(<video_preview>[\s\S]*?<\/video_preview>)/g);

        return parts.map((part, index) => {
            if (part.trim().startsWith('<video_preview>')) {
                const jsonStr = part.replace('<video_preview>', '').replace('</video_preview>', '');
                try {
                    const videoObj = JSON.parse(jsonStr);

                    if (videoObj.url && videoObj.url.startsWith('/')) {
                        videoObj.url = `${API_BASE_URL}${videoObj.url}`;
                    }
                    if (videoObj.thumbnail && videoObj.thumbnail.startsWith('/')) {
                        videoObj.thumbnail = `${API_BASE_URL}${videoObj.thumbnail}`;
                    }

                    return (
                        <div key={`video-${index}`} className="my-5">
                            <ChatMiniVideoCard
                                video={videoObj}
                                onPlay={() => setPlayingVideo(videoObj)}
                            />
                        </div>
                    );
                } catch (e) {
                    console.error("解析视频数据失败:", e);
                    return <div key={`err-${index}`} className="text-red-500 text-xs border border-red-200 p-2 rounded">视频解析失败: {jsonStr}</div>;
                }
            }

            if (part.includes('<video_preview>') && !part.includes('</video_preview>')) {
                return (
                    <span key={`loading-${index}`} className="inline-flex items-center text-violet-500 text-xs animate-pulse ml-2 bg-violet-50 px-3 py-1.5 rounded-full border border-violet-100">
                        <Loader2 size={14} className="animate-spin mr-1.5" />
                        正在生成视频组件...
                    </span>
                );
            }

            if (!part) return null;

            return (
                <ReactMarkdown
                    key={`md-${index}`}
                    remarkPlugins={[remarkGfm]}
                    components={{
                        img: ({ node, ...props }) => {
                            let imgSrc = props.src;
                            if (imgSrc) {
                                imgSrc = imgSrc.replace(/http:\/\/localhost:\d+/g, API_BASE_URL);
                                if (imgSrc.startsWith('/images')) {
                                    imgSrc = `${API_BASE_URL}${imgSrc}`;
                                }
                            }
                            return <img {...props} src={imgSrc} className="max-w-full h-auto rounded-xl shadow-md my-4 border border-slate-200 cursor-zoom-in hover:shadow-lg transition-shadow" onClick={() => window.open(imgSrc, '_blank')} />
                        },
                        code({ node, className, children, ...props }) {
                            const match = /language-(\w+)/.exec(className || '');
                            return match ? (
                                <div className="bg-slate-900 text-slate-50 p-3 rounded-xl my-3 overflow-x-auto shadow-inner border border-slate-700/50">
                                    <code className={className} {...props}>{children}</code>
                                </div>
                            ) : (
                                <code className={`${role === 'user' ? 'bg-white/20 text-white' : 'bg-violet-50 text-violet-600'} px-1.5 py-0.5 rounded-md font-mono text-[0.9em]`} {...props}>
                                    {children}
                                </code>
                            );
                        },
                        table: ({ node, ...props }) => <div className="overflow-x-auto my-3 rounded-xl border border-slate-200 shadow-sm"><table className="min-w-full divide-y divide-slate-200 text-sm" {...props} /></div>,
                        thead: ({ node, ...props }) => <thead className="bg-slate-50/80 backdrop-blur" {...props} />,
                        tbody: ({ node, ...props }) => <tbody className="bg-white divide-y divide-slate-100" {...props} />,
                        tr: ({ node, ...props }) => <tr className="hover:bg-slate-50 transition-colors" {...props} />,
                        th: ({ node, ...props }) => <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600 uppercase tracking-wider" {...props} />,
                        td: ({ node, ...props }) => <td className="px-4 py-3 whitespace-nowrap text-slate-700" {...props} />,
                        p: ({ node, ...props }) => <p className="mb-3 last:mb-0 leading-relaxed" {...props} />,
                        a: ({ node, ...props }) => <a className="text-violet-600 font-medium hover:text-violet-700 hover:underline decoration-violet-300 underline-offset-4 transition-all" target="_blank" {...props} />,
                        ul: ({ node, ...props }) => <ul className="list-disc list-outside ml-5 mb-3 space-y-1" {...props} />,
                        ol: ({ node, ...props }) => <ol className="list-decimal list-outside ml-5 mb-3 space-y-1" {...props} />,
                        li: ({ node, ...props }) => <li className="pl-1" {...props} />,
                    }}
                >
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
                    if (!activeThreadId) {
                        switchThread(data[0].id);
                    }
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
            if (!isLoading && streamBuffer) {
                setMessages(prev => {
                    const newMsgs = [...prev];
                    if (newMsgs.length > 0 && newMsgs[newMsgs.length - 1].role === 'ai') {
                        newMsgs[newMsgs.length - 1].content = streamBuffer;
                    }
                    return newMsgs;
                });
            }
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

            if (data.history && Array.isArray(data.history)) {
                setMessages(data.history);
            }
        } catch (err) {
            console.error("加载历史记录失败", err);
        } finally {
            setIsLoading(false);
        }
    };

    const createNewThread = async () => {
        if (isLoading) return;
        setIsLoading(true);

        try {
            const res = await fetch(`${API_BASE_URL}/threads`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, thread_type: 'training' })
            });

            if (!res.ok) {
                throw new Error("创建会话失败");
            }

            const newThreadData = await res.json();

            const newThread = {
                id: newThreadData.id,
                title: newThreadData.title || "新会话",
                history: []
            };

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
    };

    const handleDeleteThread = async (e, threadId) => {
        e.stopPropagation();

        if (!window.confirm("确定要删除这条历史记录吗？删除后无法恢复。")) {
            return;
        }

        try {
            const res = await fetch(`${API_BASE_URL}/threads/${threadId}?user_id=${userId}`, {
                method: 'DELETE',
            });

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
            ? currentFiles.map(f => ({
                type: f.type,
                content: f.content,
                fileName: f.fileName || f.name,
                savedPath: f.savedPath
            }))
            : null;

        const userMessage = {
            role: "user",
            content: textToSend,
            files: currentFiles.map(f => ({
                name: f.fileName || f.name,
                type: f.type,
                base64: f.type === "image" ? f.content : undefined,
                savedPath: f.savedPath
            }))
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

                const newTitle = textToSend.length > 15
                    ? textToSend.substring(0, 15) + "..."
                    : textToSend;

                setThreads(prev => prev.map(t =>
                    t.id === activeThreadId ? { ...t, title: newTitle } : t
                ));

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
                body: JSON.stringify({
                    query: textToSend,
                    thread_id: activeThreadId,
                    user_id: userId,
                    temp_context: finalTempContext
                }),
                signal: abortControllerRef.current.signal
            });

            if (!response.ok) throw new Error("API Error");
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                setStreamBuffer(prev => prev + chunk);
            }

        } catch (error) {
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

    return (
        <div className="flex h-screen bg-[#f4f7f9] text-slate-800 font-sans animate-fade-in relative overflow-hidden">
            {/* 展览级环境背景装饰 (玻璃拟态的光斑) */}
            <div className="absolute top-[-15%] left-[-10%] w-[50vw] h-[50vw] rounded-full bg-blue-500/10 blur-[120px] pointer-events-none" />
            <div className="absolute bottom-[-20%] right-[-10%] w-[60vw] h-[60vw] rounded-full bg-violet-500/10 blur-[140px] pointer-events-none" />

            {/* 1. 侧边栏 */}
            <div className={`transition-all duration-400 ease-in-out bg-slate-900 text-white flex flex-col flex-shrink-0 shadow-2xl z-30 overflow-hidden ${isSidebarOpen ? 'w-1/4' : 'w-0'}`}>
                <div className="w-[25vw] flex flex-col h-full bg-gradient-to-b from-slate-900 to-slate-800">
                    {/* 顶部标题区域 */}
                    <div className="p-5 border-b border-slate-700/50 flex items-center justify-between backdrop-blur-sm">
                        <h1 className="font-bold text-lg flex items-center gap-2 tracking-wide">
                            <MessageSquare className="text-violet-400" size={20} />
                            历史会话
                        </h1>
                    </div>

                    <div className="p-4">
                        <button
                            onClick={() => createNewThread("新会话")}
                            disabled={isLoading}
                            className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 p-3 rounded-xl text-sm font-medium transition-all shadow-lg shadow-violet-500/20 group border border-white/5"
                        >
                            <Plus size={18} className="group-hover:rotate-90 transition-transform duration-300" /> 新建会话
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto px-3 custom-scrollbar">
                        {threads.map(thread => (
                            <button
                                key={thread.id}
                                onClick={() => switchThread(thread.id)}
                                disabled={isLoading}
                                className={`group w-full text-left p-3.5 rounded-xl mb-2 text-sm flex items-center gap-3 transition-all duration-200 border ${activeThreadId === thread.id
                                    ? 'bg-white/10 text-white border-violet-400/50 shadow-inner'
                                    : 'text-slate-400 border-transparent hover:bg-white/5 hover:text-slate-200'
                                    }`}
                            >
                                <MessageSquare size={16} className={`flex-shrink-0 ${activeThreadId === thread.id ? 'text-violet-400' : 'text-slate-500 group-hover:text-slate-400'}`} />
                                <span className="truncate flex-1 font-medium">{thread.title}</span>
                                <div
                                    role="button"
                                    onClick={(e) => handleDeleteThread(e, thread.id)}
                                    className={`p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition-all opacity-0 group-hover:opacity-100 flex-shrink-0 ${activeThreadId === thread.id ? 'opacity-100' : ''}`}
                                    title="删除会话"
                                >
                                    <Trash2 size={16} />
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* 2. 主界面 */}
            <div className="flex-1 flex flex-col relative min-w-0 z-10 bg-transparent">

                {/* 顶部导航栏 (固定高度，不参与缩放) */}
                <div className="shrink-0 h-16 border-b border-white/40 flex items-center px-4 shadow-[0_2px_10px_rgba(0,0,0,0.02)] z-20 bg-white/70 backdrop-blur-xl justify-between">
                    <div className="flex items-center gap-2">
                        <button onClick={onBack} className="p-2 text-slate-500 hover:bg-white hover:shadow-sm hover:text-violet-600 rounded-xl transition-all" title="返回">
                            <ArrowLeft size={20} />
                        </button>

                        <button
                            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                            className={`p-2 rounded-xl transition-all ${isSidebarOpen ? 'bg-violet-100 text-violet-700' : 'text-slate-500 hover:bg-white hover:shadow-sm hover:text-violet-600'}`}
                            title={isSidebarOpen ? "收起历史记录" : "展开历史记录"}
                        >
                            <Menu size={20} />
                        </button>
                    </div>

                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center shadow-md">
                            <GraduationCap className="text-white" size={18} />
                        </div>
                        <h1 className="font-bold text-lg tracking-wide bg-clip-text text-transparent bg-gradient-to-r from-slate-800 to-slate-600 ml-1">
                            智能分拣助手
                        </h1>
                    </div>
                </div>

                {/* 聊天区域  */}
                <div className="flex-1 overflow-y-auto p-4 custom-scrollbar scroll-smooth">
                    <div className="max-w-3xl mx-auto space-y-6 min-h-full flex flex-col pb-4">
                        {messages.length === 0 && (
                            <div className="flex-1 flex flex-col items-center justify-center text-center mt-6 animate-in fade-in slide-in-from-bottom-8 duration-700">
                                <div className="relative group mb-8">
                                    <div className="absolute inset-0 bg-violet-400 rounded-[2.5rem] blur-xl opacity-40 group-hover:opacity-60 transition-opacity duration-500"></div>
                                    <div className="relative w-24 h-24 bg-gradient-to-tr from-blue-600 via-indigo-500 to-violet-500 rounded-[2.5rem] shadow-2xl flex items-center justify-center transform group-hover:scale-105 group-hover:rotate-3 transition-all duration-500">
                                        <Bot size={48} className="text-white drop-shadow-md" />
                                    </div>
                                </div>
                                <h2 className="text-3xl font-extrabold text-slate-800 mb-4 tracking-tight">开启智能操作指引</h2>
                                <p className="text-slate-500 mb-12 max-w-md text-base leading-relaxed">
                                    点击下方模块，快速了解智能分拣平台的核心功能与操作流程。
                                </p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-5 w-full max-w-2xl px-4">
                                    <button
                                        onClick={() => handleSend("教我使用智能分拣平台的操作界面")}
                                        className="flex items-center gap-4 p-5 bg-white/80 backdrop-blur-md border border-white/60 rounded-2xl hover:border-blue-300 hover:shadow-xl hover:shadow-blue-500/10 hover:-translate-y-1 transition-all duration-300 text-left group"
                                    >
                                        <div className="w-12 h-12 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform duration-300 border border-blue-100/50">
                                            <LayoutDashboard size={24} className="text-blue-600" />
                                        </div>
                                        <div>
                                            <div className="font-bold text-slate-700 text-lg group-hover:text-blue-700 transition-colors">操作指导</div>
                                            <div className="text-sm text-slate-400 mt-0.5">例如：系统主界面操作</div>
                                        </div>
                                    </button>

                                    <button
                                        onClick={() => handleSend("介绍一下公司的主要产品")}
                                        className="flex items-center gap-4 p-5 bg-white/80 backdrop-blur-md border border-white/60 rounded-2xl hover:border-violet-300 hover:shadow-xl hover:shadow-violet-500/10 hover:-translate-y-1 transition-all duration-300 text-left group"
                                    >
                                        <div className="w-12 h-12 bg-gradient-to-br from-violet-50 to-purple-50 rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform duration-300 border border-violet-100/50">
                                            <Package size={24} className="text-violet-600" />
                                        </div>
                                        <div>
                                            <div className="font-bold text-slate-700 text-lg group-hover:text-violet-700 transition-colors">产品介绍</div>
                                            <div className="text-sm text-slate-400 mt-0.5">例如：公司核心产品总览</div>
                                        </div>
                                    </button>
                                </div>
                            </div>
                        )}

                        {messages.map((msg, idx) => {
                            const isLastAiMessage = msg.role === 'ai' && idx === messages.length - 1;
                            const isThinking = isLastAiMessage && isLoading && !displayedContent;
                            const contentToShow = isLastAiMessage && (isLoading || isTyping) ? displayedContent : msg.content;

                            return (
                                <div key={idx} className={`flex gap-4 mb-4 w-full animate-in fade-in slide-in-from-bottom-2 duration-300 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>

                                    {/* 左侧：AI 头像 */}
                                    {msg.role === 'ai' && (
                                        <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-white to-slate-100 border border-slate-200 shadow-sm flex items-center justify-center flex-shrink-0 mt-1">
                                            <Bot size={22} className={`text-violet-600 ${isThinking || isTyping ? 'animate-pulse' : ''}`} />
                                        </div>
                                    )}

                                    {/* 中间核心区 */}
                                    <div className={`flex flex-col gap-2.5 max-w-[85%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>

                                        {/* 消息气泡 UI 升级 */}
                                        <div className={`px-5 py-4 rounded-3xl text-[15px] leading-relaxed shadow-sm transition-all duration-300 w-fit border ${msg.role === 'user'
                                            ? 'bg-gradient-to-br from-blue-600 to-violet-600 text-white rounded-tr-sm border-transparent shadow-blue-500/20'
                                            : 'bg-white/90 backdrop-blur-md border-white/60 text-slate-800 rounded-tl-sm shadow-slate-200/50'
                                            }`}>
                                            {isThinking ? (
                                                <div className="flex items-center gap-1.5 h-6 px-1">
                                                    <div className="w-2 h-2 bg-violet-400 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                                                    <div className="w-2 h-2 bg-violet-400 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                                                    <div className="w-2 h-2 bg-violet-400 rounded-full animate-bounce"></div>
                                                    <span className="text-sm font-medium text-violet-500 ml-2 animate-pulse">正在整理思绪...</span>
                                                </div>
                                            ) : (
                                                <div className={`prose prose-sm max-w-none ${msg.role === 'user' ? 'prose-invert' : 'prose-slate'}`}>
                                                    {renderMessageContent(contentToShow || msg.content, msg.role)}
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {/* 右侧：用户头像 */}
                                    {msg.role === 'user' && (
                                        <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-blue-100 to-indigo-100 flex items-center justify-center flex-shrink-0 mt-1 shadow-sm border border-blue-200/50">
                                            <User size={20} className="text-blue-600" />
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        {/* 滚动锚点 */}
                        <div ref={messagesEndRef} className="h-4 shrink-0" />
                    </div>
                </div>

                {/* 输入框区域 (不再使用 absolute 脱离文档流，稳稳扎根在底部) */}
                <div className="shrink-0 relative pt-4 pb-8 px-4 z-20">
                    {/* 微渐变底色，平滑过渡聊天区和输入区 */}
                    <div className="absolute inset-0 bg-gradient-to-t from-[#f4f7f9] via-[#f4f7f9]/90 to-transparent pointer-events-none"></div>

                    <div className="max-w-3xl mx-auto relative group flex flex-col justify-end z-10">
                        {/* 输入框主体 (Glassmorphism + 悬浮岛屿感) */}
                        <div className="bg-white/80 backdrop-blur-xl border border-white/60 rounded-[2rem] shadow-[0_8px_30px_rgb(0,0,0,0.04)] flex items-end p-2.5 gap-2 focus-within:ring-4 focus-within:ring-violet-500/10 focus-within:border-violet-300 focus-within:bg-white transition-all duration-300">
                            <textarea
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                                placeholder={"向智能分拣助手提问..."}
                                className="w-full max-h-32 bg-transparent border-none focus:ring-0 resize-none p-3.5 text-slate-700 placeholder-slate-400 text-[15px] leading-relaxed"
                                rows={1}
                                disabled={isLoading}
                            />

                            <div className="flex items-center mb-1.5 mr-1 gap-2">
                                {isLoading ? (
                                    <button onClick={handleStop} className="p-3 rounded-xl bg-rose-50 text-rose-500 hover:bg-rose-100 transition-colors"><StopCircle size={22} /></button>
                                ) : (
                                    <button
                                        onClick={() => handleSend()}
                                        disabled={!input.trim() && attachedFiles.length === 0}
                                        className={`p-3 rounded-2xl transition-all duration-300 flex items-center justify-center ${input.trim() || attachedFiles.length > 0 ? 'bg-gradient-to-r from-blue-600 to-violet-600 text-white shadow-lg shadow-violet-500/30 hover:scale-105 hover:shadow-xl hover:shadow-violet-500/40' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}
                                    >
                                        <Send size={20} className={input.trim() || attachedFiles.length > 0 ? "translate-x-[1px] -translate-y-[1px]" : ""} />
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            {playingVideo && (
                <VideoPlayerModal
                    video={playingVideo}
                    onClose={() => setPlayingVideo(null)}
                />
            )}
        </div >
    );
}