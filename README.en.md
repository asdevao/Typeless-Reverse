<div align="center">

<a href="README.md">中文</a>

</div>

# Utterly

**Speak, don't type.**

Press a hotkey and speak: transcribed on-device, refined by an LLM, and the polished text is pasted right where your cursor is.

## Install (Windows)

Download [Utterly-Setup-x64.exe](https://dl.zephyrxiang.com/speakmore/v0.9.4/Utterly-Setup-x64.exe) and double-click. The app starts automatically after install, and the first-run guide walks you through setup (pick an input mode, enter your model key, test microphone and hotkey).

> The speech recognition model (~800 MB) downloads automatically on first use, with resume support.

## Usage

- **Dictate**: press the hotkey (right Alt by default) to start speaking, press again to finish — text is pasted into the current input field
- **Translate**: hold the hotkey (right Ctrl by default), speak, and the translation is pasted — target language is set in Settings
- **Ask anything**: hold the hotkey and press Space — the recording becomes a question, answered in a result card
- **History**: browse past dictations by day in the main window; copy or retry anytime
- **Swap models**: change the refinement LLM anytime in Settings (DeepSeek, Zhipu, MiniMax, … or any OpenAI-compatible custom endpoint); the transcription model can use on-device or cloud engines

## Three input modes

- **Transcribe + refine**: on-device transcription (your voice never leaves the machine), then an LLM polishes the text — swap either hop independently
- **Native**: the recording goes straight to a multimodal model, done in one shot
- **Private**: fully on-device transcription, raw text out, no uploads, no API keys

## Privacy

In transcribe + refine mode your voice is only processed on-device — only the transcribed text is sent to the LLM. Private mode is fully offline. All data (settings, keys, history, recordings) lives in `%USERPROFILE%\.utterly`; deleting that folder wipes everything.

## License

[MIT](LICENSE)
