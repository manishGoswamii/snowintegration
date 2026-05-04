import { OpenAI } from "openai";
import { configDotenv } from "dotenv";

configDotenv();
const apiKey = process.env.OPENAI_API_KEY;
export async function callHuggingFace(prompt)
{

    const client = new OpenAI({
        baseURL: "https://router.huggingface.co/v1",
        apiKey,
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

export async function callHuggingFaceV2(data) {
	const response = await fetch(
		"https://router.huggingface.co/v1/chat/completions",
		{
			headers: {
				Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
				"Content-Type": "application/json",
			},
			method: "POST",
			body: JSON.stringify(data),
		}
	);
	const result = await response.json();
	return result;
}

// query({ 
//     messages: [
//         {
//             role: "user",
//             content: [
//                 {
//                     type: "text",
//                     text: "Describe this image in one sentence.",
//                 },
//                 {
//                     type: "image_url",
//                     image_url: {
//                         url: "https://cdn.britannica.com/61/93061-050-99147DCE/Statue-of-Liberty-Island-New-York-Bay.jpg",
//                     },
//                 },
//             ],
//         },
//     ],
//     model: "Qwen/Qwen3.5-9B:together",
// }).then((response) => {
//     console.log(JSON.stringify(response));
// });