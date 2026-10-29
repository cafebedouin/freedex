{
  // ClockSell.es: the tranche sale, the mirror of Clock.es (skunkyard SK-064). A box of tokens that lets anyone
  // perform one bounded sale per interval into one ErgoDEX v1 ERG-to-token pool, the ERG to the owner, a bounded
  // fee to whoever built the leg. Every rule of Clock.es with the sides swapped: the slice is in token units, the
  // owner's output is judged in ERG, and the optional bound is a floor (a cheap leg waits) where the buy side's
  // is a cap.
  //
  // REGISTERS (all copied unchanged to the successor; the clock is the box's own creation height)
  //   R4: SigmaProp, the owner. Spends the box at any time, under any rules, everything back.
  //   R5: Coll[Byte], the token id sold; the box's first token.
  //   R6: Coll[Byte], the pool NFT: the one ErgoDEX v1 N2T pool the legs trade against (pinned).
  //   R7: Coll[Long], the program: (slice, interval, toleranceBps, executorFee, minPrice, rentReserve)
  //       slice        token units sold per leg
  //       interval     blocks between legs, measured from this box's creation height
  //       toleranceBps the owner accepts at most this many basis points under the pool's rule
  //       executorFee  nanoERG per leg that may leave the box's ERG to anyone (the executor's output and the miner fee)
  //       minPrice     nanoERG per smallest token unit; a leg cheaper than this is invalid; 0 for no floor
  //       rentReserve  nanoERG the box keeps back for one storage-rent claim; returned with the last leg. A token
  //                    box too small to pay rent is consumed whole, tokens included, so the sell side keeps the
  //                    full fee where the buy side (ERG only) keeps none.
  //
  // LEG (no key): context variable 0 names the owner's output, 1 the successor (absent on the last leg).
  //   - due: HEIGHT - SELF.creationInfo._1 >= interval; each leg and each rent claim recreates the box.
  //   - the pool is INPUTS(0), identified by its NFT (its own script makes OUTPUTS(0) its successor).
  //   - one clocked box per transaction: no other input carries this script.
  //   - the fill is judged from this box's own slice against the pool's reserves BEFORE the trade: the owner's
  //     output must carry at least floor(x * amt * feeNum / (y * 1000 + amt * feeNum)) nanoERG, less toleranceBps,
  //     plus, on the last leg, the box's own ERG less the executor fee. BigInt as Pool.sc does.
  //   - the floor: when minPrice > 0, the ERG received >= minPrice * amt.
  //   - the owner's output: the owner's script, R4 = this box's id.
  //   - the successor: same script, every register equal, the token first among its tokens and at least
  //     held - slice of it, value >= SELF.value - executorFee, created no earlier than SLACK blocks before HEIGHT
  //     and no earlier than this leg's due height.
  //   - the last leg: when fewer than slice units would remain, the leg sells what is left and there is no
  //     successor; the owner's output also receives the rest of the ERG, the rent reserve included.
  //
  // Constants substituted before compiling: SLACK 4 (blocks), as Clock.es.
  val owner = SELF.R4[SigmaProp].get
  val tokenId = SELF.R5[Coll[Byte]].get
  val poolNft = SELF.R6[Coll[Byte]].get
  val params = SELF.R7[Coll[Long]].get
  val slice = params(0)
  val interval = params(1)
  val toleranceBps = params(2)
  val executorFee = params(3)
  val minPrice = params(4)

  val ownerIdx = getVar[Int](0)
  val leg = if (ownerIdx.isDefined) {
    val pool = INPUTS(0)
    val ownerOut = OUTPUTS(ownerIdx.get)
    val due = (HEIGHT - SELF.creationInfo._1).toLong >= interval
    val onlyOne = INPUTS.filter { (b: Box) => b.propositionBytes == SELF.propositionBytes }.size == 1
    val held = SELF.tokens(0)._2
    val last = held - slice < slice
    val amt = if (last) held else slice
    val ergBack = if (last) SELF.value - executorFee else 0L

    val x = pool.value.toBigInt
    val y = pool.tokens(2)._2.toBigInt
    val feeNum = pool.R4[Int].get.toBigInt
    val amtB = amt.toBigInt
    val got = (ownerOut.value - ergBack).toBigInt
    val rule = x * amtB * feeNum / (y * 1000.toBigInt + amtB * feeNum)
    val fillOk = got * 10000.toBigInt >= rule * (10000L - toleranceBps).toBigInt
    val floorOk = minPrice == 0L || got >= minPrice.toBigInt * amtB

    val ownerOk = allOf(Coll(
      ownerOut.propositionBytes == owner.propBytes,
      ownerOut.R4[Coll[Byte]].get == SELF.id
    ))
    val successorOk = if (last) {
      true
    } else {
      val next = OUTPUTS(getVar[Int](1).get)
      allOf(Coll(
        next.propositionBytes == SELF.propositionBytes,
        next.value >= SELF.value - executorFee,
        next.tokens.size == 1,
        next.tokens(0)._1 == tokenId,
        next.tokens(0)._2 >= held - slice,
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
      SELF.tokens(0)._1 == tokenId,
      amt > 0L,
      fillOk,
      floorOk,
      ownerOk,
      successorOk
    ))
  } else false

  owner || sigmaProp(leg)
}
