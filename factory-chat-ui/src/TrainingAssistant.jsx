import { useState, useRef, useEffect } from 'react';
import {
    Send, Plus, MessageSquare, User, Bot, Loader2, StopCircle,
    Mic, ArrowLeft, GraduationCap, Trash2, Wrench, AlertTriangle
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
            const res = await fetch(`${API_BASE_URL}/threads/${userId}?thread_type=training`);
            if (res.ok) {
                const data = await res.json();
                setThreads(data);

                if (data.length > 0) {
                    // 如果有历史记录，默认选中第一个
                    if (!activeThreadId) {
                        switchThread(data[0].id);
                    }
                } else {
                    // 如果列表为空，自动调用上面改写过的、带持久化的新建函数
                    // 注意：这里可能会导致组件加载时自动发一次 POST 请求，是正常行为
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
    const createNewThread = async () => {
        if (isLoading) return;
        setIsLoading(true); // 加个简单的 loading 锁防止重复点击

        try {
            // 1. 向后端发送 POST 请求，在数据库创建记录
            const res = await fetch(`${API_BASE_URL}/threads`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, thread_type: 'training' }) // 告诉后端是谁创建的
            });

            if (!res.ok) {
                throw new Error("创建会话失败");
            }

            // 2. 拿到后端返回的真实 DB 数据 (包含 thread_id, title 等)
            const newThreadData = await res.json();
            // 预期格式: { "id": "uuid...", "title": "新对话", "messages": [] }

            // 3. 构建前端对象
            const newThread = {
                id: newThreadData.id,
                title: newThreadData.title || "新会话",
                history: []
            };

            // 4. 更新前端列表 (插到最前面)
            setThreads(prev => [newThread, ...prev]);

            // 5. 自动选中新会话
            setActiveThreadId(newThread.id);
            setMessages([]); // 清空右侧消息
            resetTyper();    // 重置打字机状态

        } catch (error) {
            console.error("新建会话失败:", error);
            alert("无法创建新会话，请检查网络或后端服务");
        } finally {
            setIsLoading(false);
        }
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
    // 处理删除逻辑
    const handleDeleteThread = async (e, threadId) => {
        // 1. 阻止事件冒泡：防止触发外层 div 的 onClick (切换会话)
        e.stopPropagation();

        // 2. 确认提示
        if (!window.confirm("确定要删除这条历史记录吗？删除后无法恢复。")) {
            return;
        }

        try {
            // 3. 调用后端 API
            const res = await fetch(`${API_BASE_URL}/threads/${threadId}?user_id=${userId}`, {
                method: 'DELETE',
            });

            if (res.ok) {
                // 4. 更新前端状态
                const newThreads = threads.filter(t => t.id !== threadId);
                setThreads(newThreads);

                // 5. 如果删除的是当前选中的会话
                if (activeThreadId === threadId) {
                    if (newThreads.length > 0) {
                        // 切换到剩下的第一个
                        setActiveThreadId(newThreads[0].id);
                        // 这里可以选做：重新拉取该会话的消息，或者简单清空
                        setMessages([]);
                        // 触发一次切换逻辑最好，这里简化处理，手动清理
                    } else {
                        // 如果删光了，就创建一个新的
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

        // 1. 界面立即显示用户消息
        setMessages(prev => [...prev, { role: 'user', content: textToSend }]);
        setInput("");
        setIsLoading(true);
        resetTyper();

        // 2. 预占位 AI 消息
        setMessages(prev => [...prev, { role: 'ai', content: "" }]);
        abortControllerRef.current = new AbortController();

        try {
            const currentThread = threads.find(t => t.id === activeThreadId);

            // 判断条件：如果有当前会话，且标题是默认值 "新会话"
            if (currentThread && (currentThread.title === "新会话" || currentThread.title === "New Thread")) {

                const newTitle = textToSend.length > 15
                    ? textToSend.substring(0, 15) + "..."
                    : textToSend;

                // A. 更新前端显示
                setThreads(prev => prev.map(t =>
                    t.id === activeThreadId ? { ...t, title: newTitle } : t
                ));

                // B. 异步请求后端更新数据库 (fire-and-forget，不阻塞聊天)
                fetch(`${API_BASE_URL}/threads/${activeThreadId}/title`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: newTitle })
                }).catch(err => console.warn("标题自动更新失败:", err));
            }
        } catch (err) {
            console.error("标题逻辑出错，已跳过:", err);
        }
        try {
            const response = await fetch(API_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    query: textToSend,
                    thread_id: activeThreadId,
                    user_id: userId // 告诉后端是谁在发消息
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
                            // 在 className 中添加了 'group'，这是为了让里面的 group-hover 生效
                            className={`
                group w-full text-left p-3 rounded-lg mb-1 text-sm flex items-center gap-2 transition-colors 
                ${activeThreadId === thread.id
                                    ? 'bg-gray-800 text-white border-l-2 border-blue-500'
                                    : 'text-gray-400 hover:bg-gray-800'
                                }
            `}
                        >
                            <MessageSquare size={14} className="flex-shrink-0" />

                            {/* 添加了 'flex-1'。这会让文字撑满中间的空间，把后面的按钮推到最右边 */}
                            <span className="truncate flex-1">{thread.title}</span>

                            {/* 删除按钮 */}
                            <div
                                role="button"
                                onClick={(e) => handleDeleteThread(e, thread.id)}
                                className={`
                    p-1.5 rounded-md text-slate-400 hover:text-red-400 hover:bg-gray-700 transition-all 
                    opacity-0 group-hover:opacity-100 flex-shrink-0
                    ${activeThreadId === thread.id ? 'opacity-100' : ''} 
                `}
                                title="删除会话"
                            >
                                <Trash2 size={16} />
                            </div>
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
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-3xl px-4 font-sans">
                                    <button
                                        onClick={() => handleSend("教我使用自动分拣系统的桁架机械手的主控界面")}
                                        className="flex items-center gap-3 p-4 bg-white border border-gray-200 rounded-xl hover:border-blue-400 hover:shadow-md transition-all text-left group"
                                    >
                                        <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center group-hover:bg-blue-100 transition-colors">
                                            <Wrench size={20} className="text-blue-600" />
                                        </div>
                                        <div>
                                            <div className="font-semibold text-gray-700 group-hover:text-blue-700">设备操作培训</div>
                                            <div className="text-xs text-gray-400">例：教我使用自动分拣系统的桁架机械手主控界面</div>
                                        </div>
                                    </button>

                                    <button
                                        onClick={() => handleSend("自动分拣系统的设备作业工艺流程是什么？")}
                                        className="flex items-center gap-3 p-4 bg-white border border-gray-200 rounded-xl hover:border-blue-400 hover:shadow-md transition-all text-left group"
                                    >
                                        <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center group-hover:bg-blue-100 transition-colors">
                                            <AlertTriangle size={20} className="text-blue-600" />
                                        </div>
                                        <div>
                                            <div className="font-semibold text-gray-700 group-hover:text-blue-700">操作规范查询</div>
                                            <div className="text-xs text-gray-400">例：自动分拣系统的设备作业工艺流程是什么？</div>
                                        </div>
                                    </button>
                                </div>
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
                                placeholder={isRecording ? "正在听你说话..." : "输入您想学习的操作内容..."}
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