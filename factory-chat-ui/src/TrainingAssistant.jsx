import { useState, useRef, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
    Send, Plus, MessageSquare, User, Bot, Loader2, StopCircle,
    Zap, Wrench, AlertTriangle, Mic, ArrowLeft, GraduationCap
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { API_BASE_URL } from "./config";

const API_URL = `${API_BASE_URL}/chat`;
const VOICE_API_URL = `${API_BASE_URL}/voice`;
// 接收 onBack 属性用于返回主页
export default function TrainingAssistant({ onBack, userId }) {
    const [threads, setThreads] = useState([]);
    const [activeThreadId, setActiveThreadId] = useState(null);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);

    // 打字机状态
    const [streamBuffer, setStreamBuffer] = useState("");
    const [displayedContent, setDisplayedContent] = useState("");
    const [isTyping, setIsTyping] = useState(false);

    // 语音状态
    const [isRecording, setIsRecording] = useState(false);
    const [isProcessingVoice, setIsProcessingVoice] = useState(false);
    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);

    const messagesEndRef = useRef(null);
    const abortControllerRef = useRef(null);

    // -----------------------------------------------------------------------
    // 1. 获取历史会话列表的函数
    // -----------------------------------------------------------------------
    const fetchUserThreads = async () => {
        if (!userId) return;
        try {
            // 请求后端获取该用户的会话列表
            const res = await fetch(`${API_BASE_URL}/threads/${userId}`);
            if (res.ok) {
                const data = await res.json();
                setThreads(data); // 后端应返回 [{id, title, date}, ...]

                // 如果有历史记录，默认选中第一个（最新的）
                if (data.length > 0) {
                    // 如果当前没有选中的 ID，或者选中的 ID 不在列表里，就默认选第一个
                    if (!activeThreadId) {
                        switchThread(data[0].id);
                    }
                } else {
                    // 如果没有历史记录，创建一个新的空会话
                    createNewThread();
                }
            }
        } catch (error) {
            console.error("获取会话列表失败:", error);
        }
    };

    // -----------------------------------------------------------------------
    // 2. 初始化 Effect：当 userId 变化时，去后端拉取列表
    // -----------------------------------------------------------------------
    useEffect(() => {
        if (userId) {
            fetchUserThreads();
        } else {
            // 如果没有 userId (比如游客模式)，直接新建本地会话
            createNewThread();
        }
    }, [userId]);

    // 自动滚动
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, displayedContent, isLoading]);

    // 打字机逻辑
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

    // -----------------------------------------------------------------------
    // 3. 加载单条会话的历史消息
    // -----------------------------------------------------------------------
    const loadHistory = async (threadId) => {
        setIsLoading(true);
        setMessages([]); // 切换时先清空当前显示
        setStreamBuffer("");
        setDisplayedContent("");

        try {
            // 调用后端接口获取具体聊天记录
            const res = await fetch(`${API_BASE_URL}/history/${threadId}`);
            const data = await res.json();

            // 假设后端返回格式: { history: [{role: 'user', content: '...'}, ...] }
            if (data.history && Array.isArray(data.history)) {
                setMessages(data.history);
            }
        } catch (err) {
            console.error("加载历史记录失败", err);
        } finally {
            setIsLoading(false);
        }
    };

    // -----------------------------------------------------------------------
    // 4. 创建新会话
    // -----------------------------------------------------------------------
    const createNewThread = () => {
        // 生成临时 ID
        const newId = uuidv4();
        const newThread = { id: newId, title: "新会话", history: [] };

        // 将新会话插到列表最前面
        setThreads(prev => [newThread, ...prev]);
        setActiveThreadId(newId);
        setMessages([]);

        // 重置打字机
        setStreamBuffer("");
        setDisplayedContent("");
        setIsTyping(false);
    };

    // -----------------------------------------------------------------------
    // 5. 切换会话
    // -----------------------------------------------------------------------
    const switchThread = (id) => {
        if (isLoading && activeThreadId === id) return; // 如果正在加载当前会话，忽略

        setActiveThreadId(id);

        // 查找这个会话是“本地新建的空会话”还是“已有的历史会话”
        const targetThread = threads.find(t => t.id === id);

        // 如果是新创建的空会话（通常没有后端数据），直接清空界面即可
        if (targetThread && targetThread.title === "新会话" && (!targetThread.history || targetThread.history.length === 0)) {
            setMessages([]);
            setStreamBuffer("");
            setDisplayedContent("");
        } else {
            // 如果是历史会话，去后端加载消息
            loadHistory(id);
        }
    };

    const resetTyper = () => {
        setStreamBuffer("");
        setDisplayedContent("");
        setIsTyping(false);
    };

    const handleSend = async (manualInput = null) => {
        const textToSend = manualInput || input;
        if (!textToSend.trim() || isLoading) return;

        // 1. 界面立即显示用户消息
        setMessages(prev => [...prev, { role: 'user', content: textToSend }]);
        setInput("");
        setIsLoading(true);
        resetTyper();

        // 2. 预占位 AI 消息
        setMessages(prev => [...prev, { role: 'ai', content: "" }]);
        abortControllerRef.current = new AbortController();

        try {
            const response = await fetch(API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    query: textToSend,
                    thread_id: activeThreadId,
                    user_id: userId // ⚠️ 重要：告诉后端是谁在发消息
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

            // 3. 更新侧边栏标题 (如果是新会话)
            setThreads(prev => prev.map(t =>
                t.id === activeThreadId && t.title === "新会话"
                    ? { ...t, title: textToSend.substring(0, 20) } // 截取前20字做标题
                    : t
            ));

            // 这里可以加一个 refreshThreads()，如果你想实时更新列表的时间排序

        } catch (error) {
            if (error.name !== 'AbortError') {
                setStreamBuffer(prev => prev + "\n\n⚠️ 连接服务器失败，请检查后端。");
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

    // --- 语音逻辑 ---
    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorderRef.current = new MediaRecorder(stream);
            audioChunksRef.current = [];

            mediaRecorderRef.current.ondataavailable = (event) => {
                if (event.data.size > 0) audioChunksRef.current.push(event.data);
            };

            mediaRecorderRef.current.onstop = async () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                await sendAudioToBackend(audioBlob);
                stream.getTracks().forEach(track => track.stop());
            };

            mediaRecorderRef.current.start();
            setIsRecording(true);
        } catch (error) {
            console.error("无法访问麦克风:", error);
            alert("无法访问麦克风，请检查权限设置。");
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
            setIsProcessingVoice(true);
        }
    };

    const sendAudioToBackend = async (audioBlob) => {
        const formData = new FormData();
        formData.append("file", audioBlob, "voice_input.webm");

        try {
            const response = await fetch(VOICE_API_URL, { method: "POST", body: formData });
            if (!response.ok) throw new Error("识别失败");
            const data = await response.json();
            if (data.text) setInput(prev => prev + data.text);
        } catch (error) {
            console.error("语音识别错误:", error);
            alert("语音识别失败，请重试");
        } finally {
            setIsProcessingVoice(false);
        }
    };

    return (
        <div className="flex h-screen bg-gray-50 text-gray-800 font-sans animate-fade-in">
            {/* 侧边栏 */}
            <div className="w-64 bg-gray-900 text-white flex flex-col flex-shrink-0 shadow-xl z-20">
                {/* 顶部返回区域 */}
                <div className="p-4 border-b border-gray-800 flex items-center gap-3">
                    <button onClick={onBack} className="p-2 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-white transition-colors">
                        <ArrowLeft size={20} />
                    </button>
                    <h1 className="font-bold text-lg flex items-center gap-2">
                        <GraduationCap className="text-blue-500" size={24} />
                        培训助手
                    </h1>
                </div>

                <div className="p-4">
                    <button
                        onClick={() => createNewThread("新会话")}
                        disabled={isLoading}
                        className="w-full flex items-center gap-2 bg-blue-600 hover:bg-blue-700 p-3 rounded-lg text-sm transition-all shadow-md group"
                    >
                        <Plus size={16} className="group-hover:rotate-90 transition-transform" /> 新建会话
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-2 custom-scrollbar">
                    {threads.map(thread => (
                        <button
                            key={thread.id}
                            onClick={() => switchThread(thread.id)}
                            disabled={isLoading}
                            className={`w-full text-left p-3 rounded-lg mb-1 text-sm flex items-center gap-2 truncate transition-colors ${activeThreadId === thread.id
                                ? 'bg-gray-800 text-white border-l-2 border-blue-500'
                                : 'text-gray-400 hover:bg-gray-800'
                                }`}
                        >
                            <MessageSquare size={14} className="flex-shrink-0" />
                            <span className="truncate">{thread.title}</span>
                        </button>
                    ))}
                </div>
            </div>

            {/* 主界面 */}
            <div className="flex-1 flex flex-col relative bg-white">
                <div className="h-14 border-b flex items-center px-6 shadow-sm z-10 bg-white/80 backdrop-blur-md justify-between">
                    <h1 className="font-semibold text-gray-700 flex items-center gap-2">
                        <GraduationCap className="text-blue-600" size={20} />
                        <span>交互式操作培训</span>
                    </h1>
                    <div className="text-xs text-gray-400 flex items-center gap-1">
                        <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                        知识库已连接
                    </div>
                </div>

                {/* 聊天区域 */}
                <div className="flex-1 overflow-y-auto p-4 pb-32 custom-scrollbar">
                    <div className="max-w-3xl mx-auto space-y-6 min-h-full flex flex-col">
                        {messages.length === 0 && (
                            <div className="flex-1 flex flex-col items-center justify-center text-center mt-10">
                                <div className="w-20 h-20 bg-blue-50 rounded-2xl shadow-sm border border-blue-100 flex items-center justify-center mb-6">
                                    <Bot size={40} className="text-blue-600" />
                                </div>
                                <h2 className="text-2xl font-bold text-gray-800 mb-3">开启您的操作培训</h2>
                                <p className="text-gray-500 mb-10 max-w-md">
                                    您可以询问具体的设备操作步骤，我会通过图文并茂的方式指导您完成任务。
                                </p>
                            </div>
                        )}

                        {/* 消息渲染部分 */}
                        {messages.map((msg, idx) => {
                            const isLastAiMessage = msg.role === 'ai' && idx === messages.length - 1;
                            // 判断是否正在思考（Loading 且 还没有内容显示）
                            const isThinking = isLastAiMessage && isLoading && !displayedContent;

                            // 决定显示的内容：如果是最后一条且正在加载，显示打字机内容；否则显示完整内容
                            const contentToShow = isLastAiMessage && (isLoading || isTyping) ? displayedContent : msg.content;

                            return (
                                <div key={idx} className={`flex gap-4 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                    {/* AI 头像 */}
                                    {msg.role === 'ai' && (
                                        <div className="w-8 h-8 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center flex-shrink-0 mt-1">
                                            <Bot size={16} className={`text-blue-600 ${isThinking || isTyping ? 'animate-pulse' : ''}`} />
                                        </div>
                                    )}

                                    {/* 消息气泡 */}
                                    <div className={`max-w-[85%] p-4 rounded-2xl text-sm leading-7 shadow-sm transition-all duration-300 ${msg.role === 'user'
                                        ? 'bg-blue-600 text-white rounded-br-none'
                                        : 'bg-white border border-gray-100 text-gray-800 rounded-bl-none'
                                        }`}>
                                        {/* --- 核心修改：如果是思考状态，显示动画；否则显示 Markdown --- */}
                                        {isThinking ? (
                                            <div className="flex items-center gap-1.5 h-6 px-2">
                                                {/* 三个跳动的小球动画 */}
                                                <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                                                <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                                                <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce"></div>
                                                <span className="text-xs text-gray-400 ml-2">正在查阅知识库...</span>
                                            </div>
                                        ) : (
                                            <ReactMarkdown
                                                components={{
                                                    img: ({ node, ...props }) => {
                                                        // --- 🛠️ 核心修复逻辑开始 ---
                                                        let imgSrc = props.src;

                                                        // 如果链接存在，进行检查和替换
                                                        if (imgSrc) {
                                                            // 情况1：后端返回了写死的 localhost 地址 -> 替换为真实 IP
                                                            if (imgSrc.includes('localhost:8000')) {
                                                                imgSrc = imgSrc.replace('http://localhost:8000', API_BASE_URL);
                                                            }
                                                            // 情况2：后端返回了相对路径 (如 /images/xxx.png) -> 补全 IP
                                                            else if (imgSrc.startsWith('/images')) {
                                                                imgSrc = `${API_BASE_URL}${imgSrc}`;
                                                            }
                                                        }
                                                        // --- 🛠️ 核心修复逻辑结束 ---

                                                        return (
                                                            <img
                                                                {...props}
                                                                src={imgSrc} // <--- 这里使用修复后的地址
                                                                className="max-w-full h-auto rounded-lg shadow-md my-4 border border-gray-200 cursor-zoom-in hover:shadow-lg transition-shadow"
                                                                onClick={() => window.open(imgSrc, '_blank')} // <--- 点击放大时也使用修复后的地址
                                                            />
                                                        );
                                                    }
                                                }}
                                            >
                                                {contentToShow}
                                            </ReactMarkdown>
                                        )}
                                    </div>

                                    {/* 用户头像 */}
                                    {msg.role === 'user' && (
                                        <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0 mt-1">
                                            <User size={16} className="text-gray-500" />
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                        <div ref={messagesEndRef} />
                    </div>
                </div>

                {/* 输入框 (已恢复语音按钮) */}
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-white via-white to-transparent pt-12 pb-12 px-4">
                    <div className="max-w-3xl mx-auto relative group">

                        {/* 录音状态提示 */}
                        {isRecording && (
                            <div className="absolute -top-12 left-1/2 transform -translate-x-1/2 bg-red-500 text-white px-4 py-1.5 rounded-full text-xs animate-pulse shadow-md flex items-center gap-2 z-20">
                                <span className="w-2 h-2 bg-white rounded-full animate-ping"></span>
                                正在录音... 点击麦克风结束
                            </div>
                        )}

                        <div className="bg-white border border-gray-300 rounded-xl shadow-lg flex items-end p-2 gap-2 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-400">
                            <textarea
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                                placeholder={isRecording ? "正在听你说话..." : "输入您想学习的操作内容（如：教我使用自动分拣系统的桁架机械手的主控界面）..."}
                                className="w-full max-h-32 bg-transparent border-none focus:ring-0 resize-none p-3 text-gray-700 placeholder-gray-400 text-sm"
                                rows={1}
                                disabled={isLoading || isRecording || isProcessingVoice}
                            />

                            <div className="flex items-center mb-1 gap-1">
                                {/* 语音按钮 */}
                                {isProcessingVoice ? (
                                    <div className="p-2 mr-1"><Loader2 size={20} className="animate-spin text-blue-500" /></div>
                                ) : (
                                    <button
                                        onClick={isRecording ? stopRecording : startRecording}
                                        disabled={isLoading}
                                        className={`p-2 rounded-lg transition-all mr-1 ${isRecording ? 'bg-red-100 text-red-600 animate-pulse' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                                    >
                                        {isRecording ? <StopCircle size={20} /> : <Mic size={20} />}
                                    </button>
                                )}

                                {/* 发送按钮 */}
                                {isLoading ? (
                                    <button onClick={handleStop} className="p-2 rounded-lg bg-red-50 text-red-500 hover:bg-red-100"><StopCircle size={20} /></button>
                                ) : (
                                    <button
                                        onClick={() => handleSend()}
                                        disabled={!input.trim()}
                                        className={`p-2 rounded-lg transition-all ${input.trim() ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-100 text-gray-300 cursor-not-allowed'}`}
                                    >
                                        <Send size={18} />
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}