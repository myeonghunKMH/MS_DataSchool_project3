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
        this.chatButton.innerHTML = '';
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
            
            // 스크롤 높이를 이용해 보다 정확하게 계산
            const lineHeight = 20; // 1줄 높이
            const maxLines = 5; // 최대 5줄
            const maxHeight = lineHeight * maxLines;
            const contentHeight = this.textInput.scrollHeight;
            const newHeight = Math.min(contentHeight, maxHeight);
            
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
        const text = (el) => (el?.textContent || '').trim();

        // 상단 KPI
        const kpi_trades = text(document.getElementById('kpi_trades')) || 'N/A';
        const kpi_pnl = text(document.getElementById('kpi_pnl')) || 'N/A'; // 이번 달 수익
        const kpi_return = text(document.getElementById('kpi_return')) || 'N/A';
        const kpi_top_symbol = text(document.getElementById('kpi_top_symbol')) || 'N/A';
        const kpi_top_symbol_share = text(document.getElementById('kpi_top_symbol_share')) || '';

        // 총자산(최근 값) - Chart.js에서 데이터 읽기
        let equityLastKRW = null;
        try {
            const equityCanvas = document.getElementById('chart_equity');
            const equityChart = window.Chart?.getChart?.(equityCanvas);
            if (equityChart) {
                const ds = equityChart.data?.datasets?.[0];
                const arr = Array.isArray(ds?.data) ? ds.data : [];
                const last = arr.length ? arr[arr.length - 1] : null;
                if (last != null && !isNaN(last)) {
                    equityLastKRW = '₩' + Number(last).toLocaleString('ko-KR');
                }
            }
        } catch {}

        // 전체 평균 수익률(최근 값) - 리포트 차트 기준으로 항상 시도
        let peerAvgReturnLast = null;
        try {
            const rcCanvas = document.getElementById('chart_return_compare');
            const rcChart = window.Chart?.getChart?.(rcCanvas);
            if (rcChart) {
                const datasets = rcChart.data?.datasets || [];
                // 우선 '전체 평균 수익률' 라벨을 찾고, 없으면 두 번째 데이터셋(기준선 0% 대체)을 사용
                let peerDs = datasets.find(d => String(d.label).includes('전체 평균 수익률'));
                if (!peerDs && datasets.length >= 2) {
                    peerDs = datasets[1];
                }
                if (peerDs) {
                    const arr = Array.isArray(peerDs.data) ? peerDs.data : [];
                    const last = arr.length ? arr[arr.length - 1] : null;
                    if (last != null && !isNaN(last)) {
                        peerAvgReturnLast = Number(last).toFixed(2) + '%';
                    }
                }
            }
        } catch {}

        // 최근 체결 히스토리 (최대 20건 요약)
        const fills = [];
        try {
            const rows = Array.from(document.querySelectorAll('#table_recent tbody tr')).slice(0, 20);
            for (const tr of rows) {
                const tds = tr.querySelectorAll('td');
                if (tds.length >= 6) {
                    const when = text(tds[0]);
                    const sym = text(tds[1]);
                    const side = text(tds[2]);
                    const qty = text(tds[3]);
                    const price = text(tds[4]);
                    const total = text(tds[5]);
                    const realized = tds[6] ? text(tds[6]) : '';
                    fills.push(`• ${when} ${sym} ${side} 수량:${qty}, 가격:${price}, 금액:${total}${realized ? `, 손익:${realized}` : ''}`);
                }
            }
        } catch {}

        // 요약 문 구성
        let summary = '';
        summary += `이번 달 거래 횟수: ${kpi_trades}`;
        summary += `\n이번 달 수익: ${kpi_pnl}`;
        summary += `\n수익률: ${kpi_return}`;
        if (kpi_top_symbol && kpi_top_symbol !== '—' && kpi_top_symbol !== 'N/A') {
            summary += `\n가장 많이 거래한 종목: ${kpi_top_symbol}${kpi_top_symbol_share ? ` (${kpi_top_symbol_share})` : ''}`;
        }
        if (equityLastKRW) summary += `\n총자산(최근): ${equityLastKRW}`;
        if (peerAvgReturnLast) summary += `\n전체 평균 수익률(최근): ${peerAvgReturnLast}`;
        if (fills.length) summary += `\n최근 체결 ${fills.length}건:\n` + fills.join('\n');

        return { summary };
    }

    createReportPrompt(context, isInitial) {
        let promptText = `너는 유능한 개인 암호화폐 자산 관리 어드바이저야. 아래의 사용자 리포트 데이터를 보고, 사용자의 질문에 친절하게 답변해줘. 주어진 대화 내역 중 암호화폐나 자산 관리와 직접 관련 없는 질문은 응답하지 말고, 그 경우에는 간결히 '저는 사용자 리포트 분석에 집중하고 있습니다.' 라고 답해.\n\n`;
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
