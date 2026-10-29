{
  // Clock.es: the clocked box (skunkyard SK-064). A box of ERG that lets anyone perform one bounded buy per
  // interval against one ErgoDEX v1 ERG-to-token pool, the tokens to the owner, a bounded fee to whoever built
  // the leg. The same contract is a dollar-cost average (buy a slice every N blocks), a rate limit (the fence's
  // per-period allowance) and, with the mirror ClockSell.es, a tranche sale.
  //
  // REGISTERS (all copied unchanged to the successor; the clock is the only state, and it is the box's own
  // creation height)
  //   R4: SigmaProp, the owner. Spends the box at any time, under any rules, everything back.
  //   R5: Coll[Byte], the token id bought.
  //   R6: Coll[Byte], the pool NFT: the one ErgoDEX v1 N2T pool the legs trade against (pinned, so an executor
  //       cannot pick a shallow pool whose "rule" is a bad price).
  //   R7: Coll[Long], the program: (slice, interval, toleranceBps, executorFee, maxPrice, rentReserve)
  //       slice        nanoERG paid into the trade per leg
  //       interval     blocks between legs, measured from this box's creation height
  //       toleranceBps the owner accepts at most this many basis points under the pool's rule
  //       executorFee  nanoERG per leg that may leave the box to anyone (the executor's output and the miner fee)
  //       maxPrice     nanoERG per smallest token unit; a leg dearer than this is invalid; 0 for no cap
  //       rentReserve  nanoERG the box keeps back for one storage-rent claim; returned with the last leg
  //
  // LEG (no key): context variable 0 names the owner's output, 1 the successor (absent on the last leg).
  //   - due: HEIGHT - SELF.creationInfo._1 >= interval. Each leg recreates the box, so the clock restarts; a
  //     storage-rent claim restarts it too (F1), which is wanted.
  //   - the pool is INPUTS(0), identified by its NFT (its own script makes OUTPUTS(0) its successor).
  //   - one clocked box per transaction (ruling R6 of research/policy/EXPERIMENTS.md): no other input carries
  //     this script, so one owner output and one successor answer exactly one box.
  //   - the fill is judged from this box's own slice against the pool's reserves BEFORE the trade, not from the
  //     pool's aggregate change, so other trades may share the pool box: the owner's output must carry at least
  //     floor(y * amt * feeNum / (x * 1000 + amt * feeNum)) tokens, less toleranceBps. BigInt throughout, as
  //     Pool.sc does: y * amt * feeNum passes 2^63 on real pools.
  //   - the absolute cap: when maxPrice > 0, amt <= maxPrice * tokens received.
  //   - the owner's output: the owner's script, R4 = this box's id (the convention Babel and Machina use), the
  //     token first among its tokens.
  //   - the successor: same script, every register equal, no tokens, value >= SELF.value - slice - executorFee,
  //     created no earlier than SLACK blocks before HEIGHT (an executor cannot backdate the clock) and no earlier
  //     than this leg's due height (legs can never come faster than one per interval from the previous due height).
  //   - the last leg: when what remains after this leg, less the rent reserve, would not fund another full leg,
  //     there is no successor; the leg trades min(slice, SELF.value - executorFee) and the owner's output also
  //     receives the rest of the ERG. No dust successor.
  //
  // Constants substituted before compiling: SLACK 4 (blocks; a leg transaction expires that many blocks after
  // it was built, and an executor can shorten one interval by at most that much).
  val owner = SELF.R4[SigmaProp].get
  val tokenId = SELF.R5[Coll[Byte]].get
  val poolNft = SELF.R6[Coll[Byte]].get
  val params = SELF.R7[Coll[Long]].get
  val slice = params(0)
  val interval = params(1)
  val toleranceBps = params(2)
  val executorFee = params(3)
  val maxPrice = params(4)
  val rentReserve = params(5)

  val ownerIdx = getVar[Int](0)
  val leg = if (ownerIdx.isDefined) {
    val pool = INPUTS(0)
    val ownerOut = OUTPUTS(ownerIdx.get)
    val due = (HEIGHT - SELF.creationInfo._1).toLong >= interval
    val onlyOne = INPUTS.filter { (b: Box) => b.propositionBytes == SELF.propositionBytes }.size == 1
    val budgetAfter = SELF.value - rentReserve - slice - executorFee
    val last = budgetAfter < slice + executorFee
    val amt = if (last) min(slice, SELF.value - executorFee) else slice

    val x = pool.value.toBigInt
    val y = pool.tokens(2)._2.toBigInt
    val feeNum = pool.R4[Int].get.toBigInt
    val amtB = amt.toBigInt
    val got = ownerOut.tokens(0)._2.toBigInt
    val rule = y * amtB * feeNum / (x * 1000.toBigInt + amtB * feeNum)
    val fillOk = got * 10000.toBigInt >= rule * (10000L - toleranceBps).toBigInt
    val capOk = maxPrice == 0L || amtB <= maxPrice.toBigInt * got

    val ownerOk = allOf(Coll(
      ownerOut.propositionBytes == owner.propBytes,
      ownerOut.R4[Coll[Byte]].get == SELF.id,
      ownerOut.tokens(0)._1 == tokenId
    ))
    val successorOk = if (last) {
      ownerOut.value >= SELF.value - amt - executorFee
    } else {
      val next = OUTPUTS(getVar[Int](1).get)
      allOf(Coll(
        next.propositionBytes == SELF.propositionBytes,
        next.value >= SELF.value - slice - executorFee,
        next.tokens.size == 0,
        next.R4[SigmaProp].get == owner,
        next.R5[Coll[Byte]].get == tokenId,
        next.R6[Coll[Byte]].get == poolNft,
        next.R7[Coll[Long]].get == params,
        next.creationInfo._1 >= HEIGHT - $SLACK,
        next.creationInfo._1.toLong >= SELF.creationInfo._1.toLong + interval
      ))
    }
    allOf(Coll(
      due,
      onlyOne,
      pool.tokens(0)._1 == poolNft,
      pool.tokens(2)._1 == tokenId,
      amt > 0L,
      fillOk,
      capOk,
      ownerOk,
      successorOk
    ))
  } else false

  owner || sigmaProp(leg)
}
