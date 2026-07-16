// teams-lite — NAME RESOLUTION SMOKE (1:1 sidebar names)
//
// Proves that oneOnOne conversations get real names via fetchShortProfile:
//   sync list -> collect 1:1 other-member mris -> resolve -> report how many names
//   we now have. Prints given names only (first names) to limit exposure.

use anyhow::{Context, Result};
use teams_lite::{auth, teams, teams_profiles, teams_read};

const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1";

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder().user_agent(UA).http1_only().build()?;
    let csa = auth::get_token(teams_read::CSA_SCOPE).await.context("csa")?;
    let profile = auth::get_token(teams_profiles::PROFILE_SCOPE).await.context("profile")?;
    let sess = teams::connect(&http).await?;
    println!("[ok] region={} self={:?}", sess.region, sess.self_name);

    let convs = teams_read::fetch_conversations(&http, &sess, &csa).await?;
    let one_on_ones: Vec<_> = convs
        .iter()
        .filter(|c| c.is_one_on_one && !c.is_empty && c.title.is_empty() && !c.other_member_mri.is_empty())
        .collect();
    println!("[info] {} conversations, dont {} 1:1 à nommer", convs.len(), one_on_ones.len());

    let mris: Vec<String> = one_on_ones.iter().map(|c| c.other_member_mri.clone()).collect();
    // resolve in batches of 200 (endpoint tolerates large batches, keep it modest)
    let mut resolved = 0usize;
    let mut sample: Vec<String> = Vec::new();
    for chunk in mris.chunks(200) {
        let names = teams_profiles::fetch_names(&http, &sess, &profile, chunk).await?;
        resolved += names.len();
        for n in names.values() {
            if sample.len() < 8 {
                // show only the first name to limit exposure
                sample.push(n.split_whitespace().next().unwrap_or("?").to_string());
            }
        }
    }
    println!("[ok] {resolved}/{} noms 1:1 résolus via fetchShortProfile", mris.len());
    println!("     échantillon (prénoms): {sample:?}");

    anyhow::ensure!(resolved > 0, "aucun nom résolu — l'API a changé ?");
    println!("\n✅ NOMS 1:1 RÉSOLUS: la sidebar aura de vrais noms.");
    Ok(())
}
