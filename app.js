class LocalStorageAdapter {
  constructor() {
    this.storageKey = "chatState";
  }

  async load() {
    const data = localStorage.getItem(this.storageKey);
    return data ? JSON.parse(data) : null;
  }

  async save(state) {
    localStorage.setItem(this.storageKey, JSON.stringify(state));
  }
}

class ChatApp {
  constructor() {
    this.storage = new LocalStorageAdapter();
    this.state = null;
    this.currentProject = null;
    this.currentChat = null;
    this.availableModels = [];
    this.selectedModel = "gpt-3.5-turbo";
    this.initialize();
    this.setupMarkdown();
  }

  setupMarkdown() {
    marked.setOptions({
      highlight: function (code, lang) {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      },
      breaks: true,
      gfm: true,
    });
  }

  async initialize() {
    this.state = await this.loadState();
    this.initializeElements();
    this.attachEventListeners();
    this.renderProjects();
    this.renderChats();
    if (this.state.apiKey) {
      await this.fetchModels();
    }
  }

  async fetchModels() {
    if (!this.state.apiKey) return;

    try {
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: {
          Authorization: `Bearer ${this.state.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error("Failed to fetch models");
      }

      const data = await response.json();

      // Filter for chat models and sort them
      this.availableModels = data.data
        .filter((model) => model.id.includes("gpt"))
        .sort((a, b) => {
          // Put GPT-4 models first, then GPT-3.5
          if (a.id.includes("gpt-4") && !b.id.includes("gpt-4")) return -1;
          if (!a.id.includes("gpt-4") && b.id.includes("gpt-4")) return 1;
          return a.id.localeCompare(b.id);
        })
        .map((model) => model.id);

      this.updateModelSelector();
    } catch (error) {
      console.error("Error fetching models:", error);
    }
  }

  updateModelSelector() {
    const select = document.getElementById("model-select");
    select.innerHTML = this.availableModels
      .map(
        (model) =>
          `<option value="${model}" ${model === this.selectedModel ? "selected" : ""}>${model}</option>`,
      )
      .join("");
    select.disabled = false;
  }

  initializeElements() {
    this.apiKeyInput = document.getElementById("api-key");
    this.saveKeyBtn = document.getElementById("save-key");
    this.newProjectBtn = document.getElementById("new-project");
    this.newChatBtn = document.getElementById("new-chat");
    this.projectsList = document.getElementById("projects-list");
    this.chatsList = document.getElementById("chats-list");
    this.chatMessages = document.getElementById("chat-messages");
    this.userInput = document.getElementById("user-input");
    this.sendMessageBtn = document.getElementById("send-message");
    this.modelSelect = document.getElementById("model-select");

    // Set API key if exists
    this.apiKeyInput.value = this.state.apiKey || "";
  }

  attachEventListeners() {
    this.saveKeyBtn.addEventListener("click", () => this.saveApiKey());
    this.modelSelect.addEventListener("change", (e) => {
      this.selectedModel = e.target.value;
    });
    this.newProjectBtn.addEventListener("click", () => this.createNewProject());
    this.newChatBtn.addEventListener("click", () => this.createNewChat());
    this.sendMessageBtn.addEventListener("click", () => this.sendMessage());
    this.userInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
  }

  async loadState() {
    const defaultState = {
      apiKey: "",
      projects: [],
      chats: [],
      messages: {},
    };
    return (await this.storage.load()) || defaultState;
  }

  async saveState() {
    await this.storage.save(this.state);
  }

  async saveApiKey() {
    this.state.apiKey = this.apiKeyInput.value;
    await this.saveState();
    alert("API key saved!");
    await this.fetchModels();
  }

  async createNewProject() {
    const name = prompt("Enter project name:");
    if (!name) return;

    const project = {
      id: Date.now().toString(),
      name: name,
    };

    this.state.projects.push(project);
    await this.saveState();
    this.renderProjects();
  }

  async createNewChat() {
    if (!this.currentProject) {
      alert("Please select a project first!");
      return;
    }

    const name = prompt("Enter chat name:");
    if (!name) return;

    const chat = {
      id: Date.now().toString(),
      projectId: this.currentProject,
      name: name,
    };

    this.state.chats.push(chat);
    this.state.messages[chat.id] = [];
    await this.saveState();
    this.renderChats();
    this.selectChat(chat.id);
  }

  createStreamingMessage() {
    const messageId = Date.now().toString();
    this.addMessage("assistant", "", messageId);
    return messageId;
  }

  updateStreamingMessage(messageId, content) {
    const messageElement = document.querySelector(
      `[data-message-id="${messageId}"]`,
    );
    if (messageElement) {
      const parsedContent = marked.parse(content);
      messageElement.querySelector(".content").innerHTML = parsedContent;
      // Highlight any code blocks that were just added
      messageElement.querySelectorAll("pre code").forEach((block) => {
        hljs.highlightBlock(block);
      });
      // Auto-scroll to the bottom
      this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }
  }

  async readStream(response, messageId) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let content = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Decode the chunk and split into lines
        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");

        // Process each line
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices[0].delta.content;
              if (delta) {
                content += delta;
                this.updateStreamingMessage(messageId, content);
              }
            } catch (e) {
              console.error("Error parsing chunk:", e);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return content;
  }

  async sendMessage() {
    if (!this.currentChat) {
      alert("Please select a chat first!");
      return;
    }

    if (!this.state.apiKey) {
      alert("Please set your OpenAI API key first!");
      return;
    }

    const userMessage = this.userInput.value.trim();
    if (!userMessage) return;

    this.userInput.value = "";
    this.addMessage("user", userMessage);

    try {
      // Compose the message history from this chat before the new user message
      const previousMessages = this.state.messages[this.currentChat].map(
        (msg) => ({
          role: msg.role,
          content: msg.content,
        }),
      );

      // Append the new user message as well
      previousMessages.push({ role: "user", content: userMessage });

      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.state.apiKey}`,
          },
          body: JSON.stringify({
            model: this.selectedModel,
            messages: previousMessages,
            stream: true,
          }),
        },
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error.message);
      }

      const messageId = this.createStreamingMessage();
      const content = await this.readStream(response, messageId);

      // Update the state with the final content
      const messages = this.state.messages[this.currentChat];
      const lastMessage = messages[messages.length - 1];
      lastMessage.content = content;
      await this.saveState();
    } catch (error) {
      alert("Error: " + error.message);
    }
  }

  async addMessage(role, content, id = null) {
    this.state.messages[this.currentChat].push({ role, content, id });
    await this.saveState();
    this.renderMessages();
  }

  async deleteProject(projectId) {
    if (
      !confirm(
        "Are you sure you want to delete this project and all its chats?",
      )
    )
      return;

    // Remove all chats associated with this project
    const chatIdsToDelete = this.state.chats
      .filter((chat) => chat.projectId === projectId)
      .map((chat) => chat.id);

    chatIdsToDelete.forEach((chatId) => {
      delete this.state.messages[chatId];
    });

    this.state.chats = this.state.chats.filter(
      (chat) => chat.projectId !== projectId,
    );
    this.state.projects = this.state.projects.filter(
      (project) => project.id !== projectId,
    );

    if (this.currentProject === projectId) {
      this.currentProject = null;
      this.currentChat = null;
    }

    await this.saveState();
    this.renderProjects();
    this.renderChats();
    this.renderMessages();
  }

  async deleteChat(chatId) {
    if (!confirm("Are you sure you want to delete this chat?")) return;

    delete this.state.messages[chatId];
    this.state.chats = this.state.chats.filter((chat) => chat.id !== chatId);

    if (this.currentChat === chatId) {
      this.currentChat = null;
    }

    await this.saveState();
    this.renderChats();
    this.renderMessages();
  }

  renderProjects() {
    this.projectsList.innerHTML = this.state.projects
      .map(
        (project) => `
            <div class="project-item ${this.currentProject === project.id ? "active" : ""}">
                <div class="project-content" onclick="app.selectProject('${project.id}')">
                    <i class="fas fa-folder"></i>
                    ${project.name}
                </div>
                <button class="delete-btn" onclick="app.deleteProject('${project.id}')">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `,
      )
      .join("");
  }

  renderChats() {
    const projectChats = this.state.chats.filter(
      (chat) => chat.projectId === this.currentProject,
    );

    this.chatsList.innerHTML = projectChats
      .map(
        (chat) => `
            <div class="chat-item ${this.currentChat === chat.id ? "active" : ""}">
                <div class="chat-content" onclick="app.selectChat('${chat.id}')">
                    <i class="fas fa-message"></i>
                    ${chat.name}
                </div>
                <button class="delete-btn" onclick="app.deleteChat('${chat.id}')">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `,
      )
      .join("");
  }

  renderMessages() {
    if (!this.currentChat) {
      this.chatMessages.innerHTML =
        '<div class="message">Select a chat to start messaging</div>';
      return;
    }

    this.chatMessages.innerHTML = this.state.messages[this.currentChat]
      .map(
        (msg) => `
            <div class="message ${msg.role}-message" data-message-id="${msg.id || ""}">
                <strong>${msg.role}:</strong> <span class="content">${marked.parse(msg.content)}</span>
            </div>
        `,
      )
      .join("");

    // Highlight all code blocks in the rendered messages
    this.chatMessages.querySelectorAll("pre code").forEach((block) => {
      hljs.highlightBlock(block);
    });

    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

  selectProject(projectId) {
    this.currentProject = projectId;
    this.currentChat = null;
    this.renderProjects();
    this.renderChats();
    this.renderMessages();
  }

  selectChat(chatId) {
    this.currentChat = chatId;
    this.renderChats();
    this.renderMessages();
  }
}

// Initialize the app
const app = new ChatApp();
