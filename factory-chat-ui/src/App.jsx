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
        <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-gradient-to-br from-amber-50 via-slate-50 to-yellow-50">
            {/* --- 柔和的浅琥珀色与暖黄色背景 --- */}

            {/* --- 动态背景光球 (颜色换为极浅的琥珀色和鹅黄色，更像暖光) --- */}
            <div className="absolute top-[10%] left-[15%] w-[400px] h-[400px] bg-amber-400/10 rounded-full mix-blend-multiply filter blur-[80px] animate-pulse"></div>
            <div className="absolute bottom-[10%] right-[15%] w-[400px] h-[400px] bg-yellow-500/10 rounded-full mix-blend-multiply filter blur-[80px] animate-pulse" style={{ animationDelay: '2s' }}></div>

            {/* --- 主体内容 --- */}
            <div className={`relative z-10 max-w-lg w-full mx-4 transition-all duration-1000 ease-out transform ${mounted ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0'}`}>

                <div className="p-4 text-center relative group flex flex-col items-center">

                    {/* 右上角装饰小星星 (柔和的琥珀金) */}
                    <div className="absolute top-0 right-16 text-amber-400 opacity-0 group-hover:opacity-100 transition-all duration-500 transform group-hover:rotate-180">
                        <Sparkles size={24} />
                    </div>

                    {/* --- 悬浮图标设计 --- */}
                    <div className="relative w-24 h-24 mb-10 cursor-pointer">
                        {/* 底层错位背景 (极浅的奶黄色) */}
                        <div className="absolute inset-0 bg-amber-100/60 rounded-3xl rotate-6 group-hover:rotate-12 transition-transform duration-300"></div>
                        {/* 顶层主图标 (琥珀色到鹅黄色的温和渐变，去除刺眼的深橙) */}
                        <div className="absolute inset-0 bg-gradient-to-tr from-amber-500 to-yellow-400 rounded-3xl flex items-center justify-center text-white transform group-hover:-translate-y-2 transition-all duration-300 shadow-lg shadow-amber-500/10">
                            <Bot size={44} />
                        </div>
                    </div>

                    {/* --- 层次感标题组 --- */}
                    <div className="mb-6 flex flex-col items-center">
                        {/* 品牌前缀标签 (温和的琥珀色文字与极淡背景) */}
                        <span className="text-amber-600 font-bold tracking-[0.2em] text-sm uppercase mb-4 bg-amber-50/80 backdrop-blur-sm px-4 py-1.5 rounded-full border border-amber-200/60">
                            华工小筑
                        </span>
                        {/* 核心主标题 (深琥珀 - 浅橙 - 鹅黄色的平滑柔和渐变) */}
                        <h1 className="text-4xl md:text-5xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-amber-600 via-orange-400 to-yellow-500 tracking-tight">
                            智能装配协同助手
                        </h1>
                    </div>

                    {/* --- 副标题文本 --- */}
                    <p className="text-slate-500 mb-12 leading-relaxed text-[16px] max-w-lg mx-auto">
                        欢迎进入 <strong className="font-bold text-slate-800">华工筑视·智能装配与互动拼图工作站</strong>。<br />
                        我将协助您精准操作，带您全面了解公司产品体系。
                    </p>

                    {/* --- 动态按钮 (柔和渐变，没有高饱和度的刺眼感) --- */}
                    <button
                        onClick={() => setStarted(true)}
                        className="group relative w-full max-w-xs flex items-center justify-center gap-3 bg-gradient-to-r from-amber-500 to-orange-400 hover:from-amber-400 hover:to-orange-300 text-white font-medium py-4 px-8 rounded-full transition-all duration-300 transform hover:scale-[1.02] active:scale-[0.98] shadow-md shadow-amber-500/10 overflow-hidden"
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