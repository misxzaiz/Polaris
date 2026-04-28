use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateResult {
    pub success: bool,
    pub result: Option<String>,
    pub error: Option<String>,
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn baidu_translate(
    text: String,
    app_id: String,
    secret_key: String,
    to: Option<String>,
) -> TranslateResult {
    let salt = chrono::Utc::now().timestamp_millis().to_string();
    let sign_str = format!("{}{}{}{}", app_id, text, salt, secret_key);
    let sign = format!("{:x}", md5::compute(sign_str));

    let client = reqwest::Client::new();
    let url = "https://fanyi-api.baidu.com/api/trans/vip/translate";

    let target_lang = to.unwrap_or_else(|| "en".to_string());

    let params = [
        ("q", text.as_str()),
        ("from", "auto"),
        ("to", target_lang.as_str()),
        ("appid", app_id.as_str()),
        ("salt", salt.as_str()),
        ("sign", sign.as_str()),
    ];

    match client.post(url).form(&params).send().await {
        Ok(response) => {
            match response.json::<BaiduResponse>().await {
                Ok(data) => {
                    if let Some(error_code) = data.error_code {
                        let error_msg = match error_code.as_str() {
                            "52000" => "成功",
                            "52001" => "请求超时",
                            "52002" => "系统错误",
                            "52003" => "未授权用户",
                            "54000" => "必填参数为空",
                            "54001" => "签名错误",
                            "54003" => "访问频率受限",
                            "58000" => "客户端IP非法",
                            "58001" => "译文语言方向不支持",
                            "58002" => "服务当前已关闭",
                            "90107" => "认证未通过或未生效",
                            _ => &error_code,
                        };
                        return TranslateResult {
                            success: false,
                            result: None,
                            error: Some(error_msg.to_string()),
                        };
                    }

                    if let Some(trans_result) = data.trans_result {
                        let translated = trans_result
                            .iter()
                            .map(|t| t.dst.as_str())
                            .collect::<Vec<_>>()
                            .join("\n");
                        TranslateResult {
                            success: true,
                            result: Some(translated),
                            error: None,
                        }
                    } else {
                        TranslateResult {
                            success: false,
                            result: None,
                            error: Some("翻译结果为空".to_string()),
                        }
                    }
                }
                Err(e) => TranslateResult {
                    success: false,
                    result: None,
                    error: Some(format!("解析响应失败: {}", e)),
                },
            }
        }
        Err(e) => TranslateResult {
            success: false,
            result: None,
            error: Some(format!("请求失败: {}", e)),
        },
    }
}

#[derive(Debug, Deserialize)]
struct BaiduResponse {
    #[serde(default)]
    error_code: Option<String>,
    #[serde(default)]
    trans_result: Option<Vec<TransItem>>,
}

#[derive(Debug, Deserialize)]
struct TransItem {
    dst: String,
}
