const HF_TOKEN = "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";
import { OpenAI } from "openai";
export async function callHuggingFace(prompt)
{

    const client = new OpenAI({
        baseURL: "https://router.huggingface.co/v1",
        apiKey: HF_TOKEN,
    });
    
    const chatCompletion = await client.chat.completions.create({
        model: "Qwen/Qwen3-Coder-480B-A35B-Instruct:novita",
        messages: [
            {
                role: "user",
                content: prompt,
        },
    ],
});
    return chatCompletion.choices[0].message;
}