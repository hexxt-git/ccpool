<div>
  <h1 align="center">ccshare 👾</h1>
  <p align="center">
    <img src="https://img.shields.io/badge/Made%20with-Rust-black?style=for-the-badge&logo=rust&logoColor=white" alt="Made with Rust" />
    <img src="https://img.shields.io/badge/Astro-0C0C0C?style=for-the-badge&logo=astro&logoColor=white" alt="Built with Astro" />
    <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License" />
  </p>
  <img width="1000" height="500" alt="ccshare-extra-large(1)" src="https://github.com/user-attachments/assets/cb493208-5ef8-4bc6-8d5b-41a740a4a41d" />
  <p>
    > a cli to equally share claude subscriptions
  </p>
</div>

<hr/>

## 💡 What is it?

`ccshare` solves the common problem of shared AI subscription accounts where one user might unintentionally burn through the hourly or daily message limits, leaving others stranded. It acts as a lightweight traffic controller, pacing requests and ensuring equitable access to your team's subscription. 

## 👾 Key Features

- **Automated Pacing Engine**: `ccshare` automatically intercepts and queues prompts when usage spikes, enforcing a fair distribution of the available limits among all active users in your group.
- **Dynamic Reallocation**: If a team member isn't using their share of the quota, `ccshare` intelligently detects this and reallocates their tokens to active users 1 hour before the current usage window resets. No usage goes to waste.
- **Zero-Friction CLI**: Built in Rust for speed and reliability, the CLI is designed to be set up once and forgotten. It silently manages state in the background.
- **Flexible Backend State**: Synchronize usage state across your team using the cloud database or server of your choice.
- **Analytics & Cost Tracking**: Generate detailed daily and weekly breakdowns of token usage to estimate costs and analyze team activity.

---

## 🚀 Quick Start

For complete setup instructions, including database configuration, please visit our [Documentation](/docs).

---

## 🤝 Contributing

We welcome contributions! Whether you're fixing bugs, adding new features, or improving documentation, your help is appreciated. Please check out our [GitHub repository](https://github.com/hexxt-git/ccshare) to get started.

## 📜 License

This project is open-sourced under the MIT License.
