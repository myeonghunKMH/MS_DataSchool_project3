class ReportAIAssistant {
    constructor() {
        this.chatWidget = null;
        this.chatButton = null;
        this.messagesContainer = null;
        this.textInput = null;
        this.sendButton = null;
        this.closeButton = null;
        this.conversationHistory = [];
        this.isLoading = false;

        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            this.init();
        } else {
            document.addEventListener('DOMContentLoaded', () => this.init());
        }
    }

    init() {
        this.createUI();
        this.addEventListeners();
    }

    createUI() {
        if (document.getElementById('ai-chat-button')) return;

        this.chatButton = document.createElement('button');
        this.chatButton.id = 'ai-chat-button';
        this.chatButton.innerHTML = '<span>&#128172;</span>';
        document.body.appendChild(this.chatButton);

        this.chatWidget = document.createElement('div');
        this.chatWidget.id = 'ai-chat-widget';
        this.chatWidget.innerHTML = `
            <div class="chat-widget-resizer"></div>
            <div class="chat-widget-header">
                <span>AI 리포트 분석</span>
                <span class="close-btn">&times;</span>
            </div>
            <div class="chat-widget-messages"></div>
            <p class="chat-widget-disclaimer">AI는 실수를 할 수 있으며, 투자의 책임은 본인에게 있습니다.</p>
            <div class="chat-widget-input">
                <textarea rows="1" placeholder="리포트에 대해 질문하세요..."></textarea>
                <button>&#10148;</button>
            </div>
        `;
        document.body.appendChild(this.chatWidget);

        this.messagesContainer = this.chatWidget.querySelector('.chat-widget-messages');
        this.textInput = this.chatWidget.querySelector('.chat-widget-input textarea');
        this.sendButton = this.chatWidget.querySelector('.chat-widget-input button');
        this.closeButton = this.chatWidget.querySelector('.chat-widget-header .close-btn');
    }

    addEventListeners() {
        this.chatButton.addEventListener('click', () => this.toggleChatWindow());
        this.closeButton.addEventListener('click', () => this.toggleChatWindow(false));
        this.sendButton.addEventListener('click', () => this.handleUserMessage());
        
        this.textInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleUserMessage();
            }
        });

        this.textInput.addEventListener('input', () => {
            // 텍스트가 비어있으면 1줄 높이로 유지
            if (this.textInput.value.trim() === '') {
                this.textInput.style.height = '20px';
                return;
            }
            
            // 텍스트가 있으면 내용에 맞춰 높이 조절
            this.textInput.style.height = 'auto';
            
            // 실제 줄 수를 계산하여 높이 결정
            const lineHeight = 20; // 1줄 높이
            const lines = Math.max(1, this.textInput.value.split('\n').length);
            const maxLines = 5; // 최대 5줄
            
            const newHeight = Math.min(lines * lineHeight, maxLines * lineHeight);
            
            this.textInput.style.height = `${newHeight}px`;
        });
    }

    toggleChatWindow(forceShow) {
        const isVisible = this.chatWidget.classList.contains('visible');
        if (forceShow === false || isVisible) {
            this.chatWidget.classList.remove('visible');
        } else {
            this.chatWidget.classList.add('visible');
            if (this.messagesContainer.children.length === 0) {
                this.addMessageToChat('bot', '안녕하세요! 이 리포트에 대해 궁금한 점을 질문해주세요. 데이터 분석을 도와드리겠습니다.');
            }
        }
    }

    handleUserMessage() {
        const message = this.textInput.value.trim();
        if (!message || this.isLoading) return;

        this.addMessageToChat('user', message);
        this.conversationHistory.push({ role: 'user', content: message });
        this.textInput.value = '';
        this.textInput.style.height = 'auto';
        
        this.fetchContextAndCallLLM();
    }

    addMessageToChat(sender, text) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('chat-message', sender);
        messageElement.textContent = text;
        this.messagesContainer.appendChild(messageElement);
        this.scrollToBottom();
        return messageElement;
    }

    setLoadingState(active) {
        this.isLoading = active;
        if (active) {
            const loadingElement = document.createElement('div');
            loadingElement.classList.add('chat-message', 'bot', 'loading');
            loadingElement.innerHTML = '<span></span><span></span><span></span>';
            loadingElement.id = 'loading-indicator';
            this.messagesContainer.appendChild(loadingElement);
            this.scrollToBottom();
        } else {
            document.getElementById('loading-indicator')?.remove();
        }
    }

    scrollToBottom() {
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    async fetchReportContext() {
        const kpi_trades = document.getElementById('kpi_trades')?.textContent || 'N/A';
        const kpi_volume = document.getElementById('kpi_volume')?.textContent || 'N/A';
        const kpi_return = document.getElementById('kpi_return')?.textContent || 'N/A';
        const kpi_top_symbol = document.getElementById('kpi_top_symbol')?.textContent || 'N/A';
        
        return {
            summary: `이번 달 거래 횟수는 ${kpi_trades}회, 총 거래액은 ${kpi_volume}이며, 수익률은 ${kpi_return}입니다. 가장 많이 거래한 종목은 ${kpi_top_symbol}입니다.`
        };
    }

    createReportPrompt(context, isInitial) {
        let promptText = `너는 유능한 개인 자산 관리 어드바이저야. 아래의 사용자 리포트 데이터를 보고, 사용자의 질문에 친절하게 답변해줘.\n\n`;
        promptText += `== 사용자 리포트 요약 ==\n${context.summary}\n\n`;

        if (isInitial) {
            promptText += `== 임무 ==\n위 리포트 내용을 바탕으로 사용자에게 격려의 메시지와 함께 현재 자산 현황을 2문장으로 요약해줘.`;
        } else {
            promptText += `== 임무 ==\n위 리포트 내용과 이전 대화 내용을 바탕으로 사용자의 마지막 질문에 답변해줘.`;
        }
        return promptText;
    }

    async fetchContextAndCallLLM(isInitialSummary = false) {
        this.setLoadingState(true);
        try {
            const context = await this.fetchReportContext();
            const systemPrompt = this.createReportPrompt(context, isInitialSummary);
            const model = 'model-router';

            const messagesForAPI = [{ role: 'system', content: systemPrompt }, ...this.conversationHistory];
            const llmResponse = await this.callLLM(messagesForAPI, model);

            this.setLoadingState(false);
            this.addMessageToChat('bot', llmResponse);
            this.conversationHistory.push({ role: 'assistant', content: llmResponse });

        } catch (error) {
            console.error('Error in Report AI Assistant:', error);
            this.setLoadingState(false);
            this.addMessageToChat('bot', `죄송합니다. 리포트 분석 중 오류가 발생했습니다: ${error.message}`);
        }
    }

    async callLLM(messages, model) {
        const requestBody = { model, messages };
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
                headers: headers,
                credentials: 'include',
                body: JSON.stringify(requestBody)
            });
            if (!response.ok) {
                if (response.status === 401) throw new Error('인증이 필요합니다. 다시 로그인해주세요.');
                const errorData = await response.json();
                throw new Error(errorData.error || `API call failed with status: ${response.status}`);
            }
            const data = await response.json();
            return data.choices[0].message.content;
        } catch (error) {
            console.error('LLM API call error:', error);
            return `API 호출에 실패했습니다: ${error.message}`;
        }
    }
}
