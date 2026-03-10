import { useState, useEffect } from 'react';
import { Bot, ArrowRight, Sparkles } from 'lucide-react';
import TrainingAssistant from './TrainingAssistant';

export default function App() {
    const [started, setStarted] = useState(false);
    const [mounted, setMounted] = useState(false);

    // 页面加载时的淡入和上滑动画触发器
    useEffect(() => {
        setMounted(true);
    }, []);

    if (started) {
        return <TrainingAssistant onBack={() => setStarted(false)} userId="bace0701-15e3-5144-97c5-47487d543032" />;
    }

    return (
        <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-gradient-to-br from-indigo-50 via-slate-50 to-blue-50">

            {/* --- 动态背景光球 (呼吸效果，位置稍微向内靠拢，充当文本的高光背景) --- */}
            <div className="absolute top-[10%] left-[15%] w-[400px] h-[400px] bg-blue-400/20 rounded-full mix-blend-multiply filter blur-[80px] animate-pulse"></div>
            <div className="absolute bottom-[10%] right-[15%] w-[400px] h-[400px] bg-purple-400/20 rounded-full mix-blend-multiply filter blur-[80px] animate-pulse" style={{ animationDelay: '2s' }}></div>

            {/* --- 主体内容 (去除了卡片背景、边框和阴影，完全融入背景) --- */}
            <div className={`relative z-10 max-w-lg w-full mx-4 transition-all duration-1000 ease-out transform ${mounted ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0'}`}>

                <div className="p-4 text-center relative group flex flex-col items-center">

                    {/* 右上角装饰小星星 (因为没有边框了，所以位置向图标靠拢) */}
                    <div className="absolute top-0 right-16 text-blue-400 opacity-0 group-hover:opacity-100 transition-all duration-500 transform group-hover:rotate-180">
                        <Sparkles size={24} />
                    </div>

                    {/* --- 悬浮图标设计 --- */}
                    <div className="relative w-24 h-24 mb-10 cursor-pointer">
                        {/* 底层错位背景 */}
                        <div className="absolute inset-0 bg-indigo-200/50 rounded-3xl rotate-6 group-hover:rotate-12 transition-transform duration-300"></div>
                        {/* 顶层主图标 */}
                        <div className="absolute inset-0 bg-gradient-to-tr from-blue-600 to-indigo-500 rounded-3xl flex items-center justify-center text-white transform group-hover:-translate-y-2 transition-all duration-300 shadow-xl shadow-blue-500/30">
                            <Bot size={44} />
                        </div>
                    </div>

                    {/* --- 渐变标题 --- */}
                    <h1 className="text-4xl lg:text-5xl font-extrabold mb-6 bg-clip-text text-transparent bg-gradient-to-r from-blue-700 to-indigo-600 tracking-tight">
                        智能分拣助手
                    </h1>

                    {/* --- 副标题文本 --- */}
                    <p className="text-slate-600 mb-12 leading-relaxed text-[16px] max-w-sm mx-auto">
                        欢迎进入智能分拣平台。<br />我将协助您精准操作，带您全面了解公司产品体系。
                    </p>

                    {/* --- 动态按钮 (改为圆润的胶囊按钮，更搭配无边框设计) --- */}
                    <button
                        onClick={() => setStarted(true)}
                        className="group relative w-full max-w-xs flex items-center justify-center gap-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-medium py-4 px-8 rounded-full transition-all duration-300 transform hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-blue-500/25 overflow-hidden"
                    >
                        <span className="text-lg tracking-wide relative z-10">立即进入助手</span>
                        {/* 箭头会有向右滑动的动画 */}
                        <ArrowRight size={22} className="relative z-10 group-hover:translate-x-1 transition-transform duration-300" />
                    </button>

                </div>
            </div>
        </div>
    );
}