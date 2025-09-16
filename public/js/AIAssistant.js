/**
 * AI Assistant Module
 * Creates a global AIAssistant object.
 */

const AIAssistant = (() => {
    let chatWidget, chatButton, messagesContainer, textInput, sendButton, closeButton;
    let conversationHistory = [];
    let isLoading = false;

    const init = () => {
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            createUI();
            addEventListeners();
        } else {
            document.addEventListener('DOMContentLoaded', () => {
                createUI();
                addEventListeners();
            });
        }
    };

    const createUI = () => {
        if (document.getElementById('ai-chat-button')) return;
        chatButton = document.createElement('button');
        chatButton.id = 'ai-chat-button';
        chatButton.innerHTML = '<span>&#129302;</span>';
        document.body.appendChild(chatButton);
        chatWidget = document.createElement('div');
        chatWidget.id = 'ai-chat-widget';
        chatWidget.innerHTML = `
            <div class="chat-widget-resizer"></div>
            <div class="chat-widget-header"><span>AI 시장 분석</span><span class="close-btn">&times;</span></div>
            <div class="chat-widget-messages"></div>
            <p class="chat-widget-disclaimer">AI는 실수를 할 수 있으며, 투자의 책임은 본인에게 있습니다.</p>
            <div class="chat-widget-input"><textarea rows="1" placeholder="질문을 입력하세요..."></textarea><button>&#10148;</button></div>
        `;
        document.body.appendChild(chatWidget);
        messagesContainer = chatWidget.querySelector('.chat-widget-messages');
        textInput = chatWidget.querySelector('.chat-widget-input textarea');
        sendButton = chatWidget.querySelector('.chat-widget-input button');
        closeButton = chatWidget.querySelector('.chat-widget-header .close-btn');
    };

    const addEventListeners = () => {
        const resizer = chatWidget.querySelector('.chat-widget-resizer');

        chatButton.addEventListener('click', toggleChatWindow);
        closeButton.addEventListener('click', () => toggleChatWindow(false));
        sendButton.addEventListener('click', handleUserMessage);
        
        // Enter 키 입력 (Shift+Enter로 줄바꿈)
        textInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleUserMessage();
            }
        });

        // 입력창 자동 높이 조절
        textInput.addEventListener('input', () => {
            // 텍스트가 비어있으면 1줄 높이로 유지
            if (textInput.value.trim() === '') {
                textInput.style.height = '20px';
                return;
            }
            
            // 텍스트가 있으면 내용에 맞춰 높이 조절
            textInput.style.height = 'auto';
            
            // 실제 줄 수를 계산하여 높이 결정
            const lineHeight = 20; // 1줄 높이
            const lines = Math.max(1, textInput.value.split('\n').length);
            const maxLines = 5; // 최대 5줄
            
            const newHeight = Math.min(lines * lineHeight, maxLines * lineHeight);
            
            textInput.style.height = `${newHeight}px`;
        });

        // 채팅창 높이 조절 로직
        const onMouseMove = (e) => {
            const dy = e.clientY - startY;
            const newHeight = startHeight - dy;
            if (newHeight > 200 && newHeight < window.innerHeight * 0.8) {
                chatWidget.style.height = `${newHeight}px`;
            }
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        let startY, startHeight;
        resizer.addEventListener('mousedown', (e) => {
            startY = e.clientY;
            startHeight = parseInt(document.defaultView.getComputedStyle(chatWidget).height, 10);
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    };

    const toggleChatWindow = (forceShow) => {
        const isVisible = chatWidget.classList.contains('visible');
        if (forceShow === false || isVisible) {
            chatWidget.classList.remove('visible');
        } else {
            chatWidget.classList.add('visible');
            if (messagesContainer.children.length === 0) {
                getInitialSummary();
            }
        }
    };

    const handleUserMessage = () => {
        const message = textInput.value.trim();
        if (!message || isLoading) return;
        addMessageToChat('user', message);
        conversationHistory.push({ role: 'user', content: message });
        textInput.value = '';
        textInput.style.height = '20px'; // 메시지 전송 후 1줄 높이로 리셋
        fetchContextAndCallLLM();
    };

    const addMessageToChat = (sender, text) => {
        const messageElement = document.createElement('div');
        messageElement.classList.add('chat-message', sender);
        
        if (sender === 'bot') {
            // 봇 메시지 가독성 개선
            let formattedText = text
                // 숫자와 퍼센트를 강조
                .replace(/(\d+(?:,\d{3})*(?:\.\d+)?%?원?)/g, '<em>$1</em>')
                // 코인명 강조
                .replace(/(비트코인|이더리움|리플|BTC|ETH|XRP)/g, '<strong>$1</strong>')
                // 중요한 키워드 강조
                .replace(/(상승|하락|급등|급락|돌파|지지|저항)/g, '<strong>$1</strong>')
                // 문장 간 간격 개선을 위한 줄바꿈 처리
                .replace(/\. ([가-힣A-Z])/g, '.\n\n$1');
            
            messageElement.innerHTML = formattedText;
        } else {
            // 사용자 메시지는 텍스트만
            messageElement.textContent = text;
        }
        
        messagesContainer.appendChild(messageElement);
        scrollToBottom();
        return messageElement;
    };

    const setLoadingState = (active) => {
        isLoading = active;
        if (active) {
            const loadingElement = document.createElement('div');
            loadingElement.classList.add('chat-message', 'bot', 'loading');
            loadingElement.innerHTML = '<span></span><span></span><span></span>';
            loadingElement.id = 'loading-indicator';
            messagesContainer.appendChild(loadingElement);
            scrollToBottom();
        } else {
            document.getElementById('loading-indicator')?.remove();
        }
    };

    const scrollToBottom = () => {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    };

    const getInitialSummary = async () => {
        addMessageToChat('bot', '안녕하세요! 현재 실시간 암호화폐 시장 상황을 종합적으로 분석하고 있습니다. 잠시만 기다려주세요.');
        fetchContextAndCallLLM(true);
    };

    const fetchRealNews = async () => {
        try {
            const response = await fetch('/api/crypto-news?limit=50');
            const result = await response.json();
            if (result.success && result.data) {
                return result.data; // 전체 뉴스 객체 배열 반환
            }
            return [];
        } catch (error) {
            console.error("실제 뉴스 데이터 로딩 오류:", error);
            return [];
        }
    };

    const getCandleDataForCoin = async (coin, unit) => {
        const chartManager = window.TradingApp?.app()?.chartManager;
        if (!chartManager) return null;
        if (chartManager.state.activeCoin === coin) {
            return chartManager.lastCandleData;
        }
        const cachedData = chartManager.cacheManager.get(coin, unit);
        if (cachedData) {
            return cachedData.map(d => ({
                time: Math.floor(new Date(d.candle_date_time_kst).getTime() / 1000),
                open: d.opening_price,
                high: d.high_price,
                low: d.low_price,
                close: d.trade_price,
                volume: d.candle_acc_trade_volume
            })).reverse();
        }
        try {
            const response = await fetch(`/api/candles?unit=${unit}&market=${coin}&count=100`);
            const data = await response.json();
            if (!data || data.length === 0) return null;
            chartManager.cacheManager.set(coin, unit, data);
            return data.map(d => ({
                time: Math.floor(new Date(d.candle_date_time_kst).getTime() / 1000),
                open: d.opening_price,
                high: d.high_price,
                low: d.low_price,
                close: d.trade_price,
                volume: d.candle_acc_trade_volume
            })).reverse();
        } catch (error) {
            console.error(`${coin} 데이터 fetch 오류:`, error);
            return null;
        }
    };

    const fetchContextAndCallLLM = async (isInitialSummary = false) => {
        setLoadingState(true);
        try {
            const chartManager = window.TradingApp?.app()?.chartManager;
            if (!chartManager) throw new Error("ChartManager를 찾을 수 없습니다.");

            const allCoinsData = [];
            const marketCodes = window.APP_CONSTANTS?.MARKET_CODES || ["KRW-BTC", "KRW-ETH", "KRW-XRP"];
            const activeUnit = chartManager.state.activeUnit || '60';

            for (const coin of marketCodes) {
                const candleData = await getCandleDataForCoin(coin, activeUnit);
                if (candleData && candleData.length >= 52) {
                    const indicators = TechnicalIndicatorManager.calculateAllIndicators(candleData);
                    allCoinsData.push({ coin, candleData, indicators });
                } else {
                    console.warn(`${coin}의 분석 데이터가 부족하여 건너뜁니다.`);
                }
            }

            if (allCoinsData.length === 0) {
                throw new Error("분석할 수 있는 코인 데이터가 없습니다.");
            }

            const realNews = await fetchRealNews(); // 실제 뉴스 데이터 호출
            const systemPrompt = createPrompt(allCoinsData, realNews, isInitialSummary);
            const messagesForAPI = [{ role: 'system', content: systemPrompt }, ...conversationHistory];
            const llmResponse = await callLLM(messagesForAPI);

            setLoadingState(false);
            addMessageToChat('bot', llmResponse);
            conversationHistory.push({ role: 'assistant', content: llmResponse });

        } catch (error) {
            console.error('Error in AI Assistant:', error);
            setLoadingState(false);
            addMessageToChat('bot', `죄송합니다. 데이터를 분석하는 중 오류가 발생했습니다: ${error.message}`);
        }
    };

    const createPrompt = (allCoinsData, news, isInitial) => {
        const coinNames = window.APP_CONSTANTS?.COIN_NAMES || {};
        let promptText = `너는 친절하고 유능한 금융 어드바이저야. 아래의 시장 데이터와 최신 뉴스를 바탕으로, 전문 용어는 최대한 피하고 일반인이 이해하기 쉽게 현재 시장 상황을 요약해줘. 기술적 지표 이름(예: RSI, 볼린저밴드)은 절대로 직접 언급하지 말고, 그 의미만 분석에 활용해야 해. 주어진 대화 내역 중 시장 상황과 직접 관련 없는 질문은 응답하지 말고, 그 경우에는 간결히 '저는 암호화폐 시장 분석에 집중하고 있습니다.' 라고 답해. \n\n`;
        
        promptText += `== 주요 코인 시장 현황 ==\n`;
        allCoinsData.forEach(({ coin, candleData, indicators }) => {
            const lastCandle = candleData[candleData.length - 1];
            const prevCandle = candleData[candleData.length - 2];
            const coinName = coinNames[coin] || coin;

            promptText += `\n[${coinName} (${coin})]\n`;
            promptText += `- 현재가: ${Math.round(lastCandle.close)}원\n`;
            promptText += `- 전날 대비: ${((lastCandle.close - prevCandle.close) / prevCandle.close * 100).toFixed(2)}%\n`;
            if (indicators?.volumeProfile) {
                promptText += `- 주요 지지/저항선: 약 ${Math.round(indicators.volumeProfile.poc)}원 (최근 거래량 집중 구간)\n`;
            }
        });

        promptText += `\n== 기술적 분석 참고자료 (분석에만 활용) ==\n`;
        allCoinsData.forEach(({ coin, indicators }) => {
            promptText += `\n[${coinNames[coin] || coin}]\n`;
            if (indicators) {
                for (const [key, value] of Object.entries(indicators)) {
                    if (value) promptText += `- ${key}: ${value.interpretation}\n`;
                }
            }
        });

        promptText += `\n== 주요 뉴스 (감정분석 포함) ==\n`;
        if (news && news.length > 0) {
            promptText += news.map(n => `[${n.sentiment || '중립'}] ${n.title}`).join('\n') + '\n';
        } else {
            promptText += "별다른 뉴스 없음\n";
        }

        if (isInitial) {
            promptText += `\n== 임무 ==\n위 코인들의 상황과 **특히 아래 뉴스들의 내용과 감정분석 결과를 비중있게** 종합해서, 현재 시장의 전반적인 특징과 흐름을 3-5문장으로 요약해줘.\n - '요약하면' 같은 군더더기 표현은 사용하지 마.\n 어떤 코인이 상대적으로 강세인지, 시장을 주도하는 흐름이 있는지 등을 포함해서 설명해줘. 절대로 '매수', '매도', '투자'와 같은 직접적인 투자 조언이나 권유는 하지 마.`;
        } else {
            promptText += `\n== 임무 ==\n위 데이터와 이전 대화 내용을 바탕으로 마지막 사용자 질문에 대해 **2~4문장으로 간결하게 핵심만 답변해줘.**\n- '요약하면' 같은 군더더기 표현은 사용하지 마.\n- 절대로 '매수', '매도', '진입', '추천'과 같이 특정 행동을 권유하거나 직접적인 투자 조언을 하지 마. 대신 각 코인의 현재 상황과 잠재적인 흐름에 대한 객관적인 인사이트만 제공해.`;
        }

        return promptText;
    };

    const callLLM = async (messages) => {
        const requestBody = { model: 'model-router', messages };
        try {
            const headers = {
                'Content-Type': 'application/json',
            };

            // Keycloak 토큰이 있으면 Authorization 헤더에 추가
            if (window.keycloak && window.keycloak.token) {
                headers['Authorization'] = 'Bearer ' + window.keycloak.token;
            }

            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',  
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                // 401 Unauthorized의 경우, 사용자가 다시 로그인해야 할 수 있음을 알림
                if (response.status === 401) {
                    throw new Error('인증이 필요합니다. 다시 로그인해주세요.');
                }
                const errorData = await response.json();
                throw new Error(errorData.error || `API call failed with status: ${response.status}`);
            }
            const data = await response.json();
            return data.choices[0].message.content;
        } catch (error) {
            console.error('LLM API call error:', error);
            return `API 호출 중 문제가 발생했습니다: ${error.message}`;
        }
    };

    return { init };
})();