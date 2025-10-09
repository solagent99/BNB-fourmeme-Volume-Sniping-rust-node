// rust-executor/src/main.rs
use actix_web::{post, web, App, HttpResponse, HttpServer, Responder};
use ethers::prelude::*;
use serde::Deserialize;
use std::env;
use std::sync::Arc;

#[derive(Deserialize)]
struct BuyRequest {
    target_token: String,
    buy_amount_bnb: String, // decimal string, e.g. "0.02"
    slippage: f64,
    deadline_secs: u64,
}

#[post("/buy")]
async fn buy(req: web::Json<BuyRequest>) -> impl Responder {
    // Load env variables
    let rpc_url =
        env::var("RPC_URL").unwrap_or_else(|_| "https://bsc-testnet.example".to_string());
    let private_key = match env::var("PRIVATE_KEY") {
        Ok(k) => k,
        Err(_) => return HttpResponse::BadRequest().body("PRIVATE_KEY not set in executor env"),
    };
    let router_addr: Address = match env::var("ROUTER_ADDRESS") {
        Ok(s) => match s.parse() {
            Ok(a) => a,
            Err(_) => return HttpResponse::BadRequest().body("Invalid ROUTER_ADDRESS"),
        },
        Err(_) => {
            return HttpResponse::BadRequest().body("ROUTER_ADDRESS not set in executor env")
        }
    };

    // Provider & signer setup
    let provider = match Provider::<Http>::try_from(rpc_url.clone()) {
        Ok(p) => p,
        Err(e) => {
            return HttpResponse::InternalServerError()
                .body(format!("Failed to create provider: {}", e))
        }
    };

    let chain_id: u64 = env::var("CHAIN_ID")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(97u64); // default BSC Testnet chain id

    let wallet: LocalWallet = match private_key.parse() {
        Ok(w) => w.with_chain_id(chain_id),
        Err(_) => return HttpResponse::BadRequest().body("Invalid PRIVATE_KEY"),
    };

    let client = SignerMiddleware::new(provider.clone(), wallet);
    let client = Arc::new(client);

    // Parse buy amount
    let buy_amount_f: f64 = match req.buy_amount_bnb.parse() {
        Ok(v) => v,
        Err(_) => return HttpResponse::BadRequest().body("Invalid buy_amount_bnb"),
    };
    let wei_amount = match ethers::utils::parse_ether(buy_amount_f) {
        Ok(v) => v,
        Err(_) => return HttpResponse::BadRequest().body("Invalid buy_amount_bnb (parse error)"),
    };

    // Minimal router ABI (WETH, getAmountsOut, swapExactETHForTokensSupportingFeeOnTransferTokens)
    let router_abi_json = r#"
    [
      {"constant":true,"inputs":[],"name":"WETH","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
      {"inputs":[{"internalType":"uint256","name":"amountOutMin","type":"uint256"},{"internalType":"address[]","name":"path","type":"address[]"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"deadline","type":"uint256"}],"name":"swapExactETHForTokensSupportingFeeOnTransferTokens","outputs":[],"stateMutability":"payable","type":"function"},
      {"inputs":[{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"address[]","name":"path","type":"address[]"}],"name":"getAmountsOut","outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],"stateMutability":"view","type":"function"}
    ]
    "#;

    let router_abi: Abi = match serde_json::from_str(router_abi_json) {
        Ok(a) => a,
        Err(e) => {
            return HttpResponse::InternalServerError()
                .body(format!("Failed to parse router ABI: {}", e))
        }
    };

    let router = Contract::new(router_addr, router_abi, client.clone());

    // Read WBNB/WETH from router
    let wbnb: Address = match router
        .method::<(), Address>("WETH", ())
        .and_then(|method| async move { method.call().await })
        .await
    {
        Ok(addr) => addr,
        Err(e) => {
            return HttpResponse::InternalServerError()
                .body(format!("Failed to read WETH from router: {}", e))
        }
    };

    // Parse target token address
    let target: Address = match req.target_token.parse() {
        Ok(a) => a,
        Err(_) => return HttpResponse::BadRequest().body("target_token is not a valid address"),
    };

    let path: Vec<Address> = vec![wbnb, target];

    // Try to getAmountsOut to compute amountOutMin (optional)
    let amounts_out_res = router
        .method::<(U256, Vec<Address>), Vec<U256>>("getAmountsOut", (wei_amount, path.clone()))
        .and_then(|m| async move { m.call().await })
        .await;

    let mut amount_out_min = U256::zero();
    if let Ok(amounts) = amounts_out_res {
        if amounts.len() >= 2 {
            let expected = amounts[1];
            // Compute minimum with slippage: expected * (1 - slippage)
            let slippage = req.slippage.clamp(0.0, 0.99);
            // To avoid float -> integer inaccuracies, compute using u128 if possible.
            let expected_u128 = expected.as_u128();
            let factor = (1.0 - slippage) as f64;
            let min_f = (expected_u128 as f64) * factor;
            amount_out_min = U256::from(min_f as u128);
        }
    }

    // Deadline
    let deadline_u64: u64 =
        (chrono::Utc::now().timestamp() as u64).saturating_add(req.deadline_secs);
    let deadline = U256::from(deadline_u64);

    // Build the swap call
    let swap_call = router.method::<(U256, Vec<Address>, Address, U256), ()>(
        "swapExactETHForTokensSupportingFeeOnTransferTokens",
        (amount_out_min, path.clone(), client.address(), deadline),
    );

    let mut call = match swap_call {
        Ok(mut m) => {
            m.tx.set_value(wei_amount);
            m
        }
        Err(e) => {
            return HttpResponse::InternalServerError()
                .body(format!("Failed to construct swap call: {}", e))
        }
    };

    // Send transaction
    let pending = match call.send().await {
        Ok(p) => p,
        Err(e) => return HttpResponse::InternalServerError().body(format!("Error sending tx: {}", e)),
    };

    // Wait for receipt (this will wait until mined or error)
    match pending.await {
        Ok(Some(receipt)) => {
            let tx_hash_hex = format!("0x{:x}", receipt.transaction_hash);
            let status = receipt.status.map(|s| s.as_u64()).unwrap_or_default();
            HttpResponse::Ok().json(serde_json::json!({ "tx_hash": tx_hash_hex, "status": status }))
        }
        Ok(None) => HttpResponse::Ok().body("Transaction pending (no receipt yet)"),
        Err(e) => HttpResponse::InternalServerError().body(format!("Error awaiting tx: {}", e)),
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    dotenv::dotenv().ok();
    let bind = env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".to_string());

    println!("Starting Rust executor on {}", bind);

    HttpServer::new(|| App::new().service(buy))
        .bind(bind)?
        .run()
        .await
}
