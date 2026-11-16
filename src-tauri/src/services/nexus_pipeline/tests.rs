#[cfg(test)]
mod tests {
    use super::types::*;
    use super::advance::*;

    fn roles() -> HashMap<String, String> {
        [
            ("pm", "developer"),
            ("ux", "developer"),
            ("fe", "developer"),
            ("be", "developer"),
            ("devops", "developer"),
            ("qa1", "qa"),
            ("rc", "gate-keeper"),
            ("orch", "orchestrator"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    fn slugs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn plan_waves_orders_by_role_and_chunks() {
        let members = slugs(&["orch", "pm", "ux", "fe", "be", "devops", "qa1", "rc"]);
        let waves = plan_waves(&members, &roles(), 3);
        // developer 5 人在前(保持相对顺序),qa/gate 次之,orchestrator 最后
        assert_eq!(waves[0], slugs(&["pm", "ux", "fe"]));
        assert_eq!(waves[1], slugs(&["be", "devops", "qa1"]));
        assert_eq!(waves[2], slugs(&["rc", "orch"]));
    }

    #[test]
    fn wave_advance_and_completion() {
        let waves = vec![slugs(&["a", "b"]), slugs(&["c"])];
        let mut p = RosterPipeline::new(
            "t1".into(), "s".into(), "g".into(), "src".into(), None, waves,
        );
        assert_eq!(p.current_wave_pending(), slugs(&["a", "b"]));
        p.record_dispatched("a", "d-a");
        p.record_dispatched("b", "d-b");

        // a 完成:b 未终态,不推进
        let r = p.on_member_terminal("d-a", true, Some("structured"));
        assert!(r.to_dispatch.is_empty() && !r.completed);

        // b 失败:波终态(失败也算终态),推进到波2
        let r = p.on_member_terminal("d-b", false, None);
        assert_eq!(r.to_dispatch, slugs(&["c"]));
        assert_eq!(p.current_wave, 1);

        p.record_dispatched("c", "d-c");
        let r = p.on_member_terminal("d-c", true, None);
        assert!(r.completed);
        assert_eq!(p.status, "completed");
    }

    #[test]
    fn concurrency_backfill_before_advance() {
        // 波内 3 人,只派出 2 人(并发满),完成 1 人后应先补派 pending 而非推进
        let waves = vec![slugs(&["a", "b", "c"]), slugs(&["d"])];
        let mut p = RosterPipeline::new(
            "t2".into(), "s".into(), "g".into(), "src".into(), None, waves,
        );
        p.record_dispatched("a", "d-a");
        p.record_dispatched("b", "d-b");
        // c 留 pending
        let r = p.on_member_terminal("d-a", true, None);
        assert_eq!(r.to_dispatch, slugs(&["c"]));
        assert_eq!(p.current_wave, 0);
    }

    #[test]
    fn unknown_dispatch_id_is_noop() {
        let mut p = RosterPipeline::new(
            "t3".into(), "s".into(), "g".into(), "src".into(), None, vec![slugs(&["a"])],
        );
        let r = p.on_member_terminal("nope", true, None);
        assert!(r.to_dispatch.is_empty() && !r.completed);
    }

    #[test]
    fn record_summary_truncates_and_feeds_reference() {
        let waves = vec![slugs(&["a"]), slugs(&["b"])];
        let mut p = RosterPipeline::new(
            "t5".into(), "s".into(), "g".into(), "src".into(), None, waves,
        );
        p.record_dispatched("a", "d-a");
        let long: String = "摘".repeat(1000);
        p.record_summary("d-a", &long);
        assert_eq!(p.member_summaries["a"].chars().count(), 801); // 800 + 省略号
        p.record_summary("nope", "ignored"); // 未知 dispatch_id 无操作
        assert_eq!(p.member_summaries.len(), 1);

        // 推进到波2后,b 的 prompt 应含 a 的摘要
        p.on_member_terminal("d-a", true, None);
        let prompt = build_member_prompt(&p, "b", &roles());
        assert!(prompt.contains("### a"));
        assert!(prompt.contains("摘摘摘"));
        assert!(prompt.contains("REFERENCE"));
    }

    #[test]
    fn persistence_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let p = RosterPipeline::new(
            "t4".into(), "s".into(), "g".into(), "src".into(), None, vec![slugs(&["a"])],
        );
        save_pipeline(tmp.path(), &p).unwrap();
        let loaded = load_pipeline(tmp.path(), "t4").unwrap();
        assert_eq!(loaded.id, "t4");
        assert_eq!(loaded.waves, vec![slugs(&["a"])]);
    }
}
