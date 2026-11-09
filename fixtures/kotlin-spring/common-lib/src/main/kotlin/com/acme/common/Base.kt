package com.acme.common

interface Shape {
  fun area(): Double

  val name: String
}

abstract class Base : Shape {
  override val name: String = "base"

  open fun describe(): String = "$name: ${area()}"

  companion object {
    const val API = "/v1"
    const val UNIT = "m2"
  }
}

@Target(AnnotationTarget.CLASS)
@Retention(AnnotationRetention.RUNTIME)
annotation class Audited

fun String.shout(): String = uppercase()
